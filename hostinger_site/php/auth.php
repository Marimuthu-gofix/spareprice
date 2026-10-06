<?php
/**
 * Sign-in for the dashboard: who is using it and what they may do.
 *
 *   admin  sees prices, downloads Excel, starts scrapes, manages accounts
 *   user   sees prices and downloads Excel
 *
 * Accounts live in the dashboard_users table of the same database as the
 * prices. Passwords are stored only as hashes. The price API in api/ is not
 * affected: scrapers keep using their X-API-Key header.
 */
declare(strict_types=1);

const SP_SESSION_NAME = 'spareprice_session';
const SP_SESSION_IDLE_SECONDS = 8 * 3600;   // signed out after 8 hours without a page load
const SP_ROLES = ['admin' => 'Admin', 'user' => 'User'];
const SP_PASSWORD_MIN = 8;
const SP_LOGIN_WINDOW_SECONDS = 600;        // failures are counted over 10 minutes
const SP_LOGIN_MAX_PER_VISITOR = 8;         // then that visitor waits out the window
const SP_LOGIN_MAX_PER_ACCOUNT = 50;        // then the account waits, whoever is trying

// ---------------------------------------------------------------- session
function sp_is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function sp_session_start(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name(SP_SESSION_NAME);
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => sp_is_https(), 'httponly' => true, 'samesite' => 'Lax']);
    session_start();
    if (isset($_SESSION['user_id'], $_SESSION['last_seen']) && time() - (int) $_SESSION['last_seen'] > SP_SESSION_IDLE_SECONDS) {
        $_SESSION = [];
        session_regenerate_id(true);
    }
    if (isset($_SESSION['user_id'])) {
        $_SESSION['last_seen'] = time();
    }
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(20));
    }
}

/** A value every form carries, so another site cannot submit forms for a signed-in person. */
function sp_csrf_token(): string
{
    return (string) ($_SESSION['csrf'] ?? '');
}

function sp_csrf_ok(): bool
{
    $given = (string) ($_POST['csrf'] ?? ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''));
    return $given !== '' && sp_csrf_token() !== '' && hash_equals(sp_csrf_token(), $given);
}

function sp_flash(string $type, string $text): void
{
    $_SESSION['flash'] = ['type' => $type, 'text' => $text];
}

function sp_take_flash(): ?array
{
    $flash = $_SESSION['flash'] ?? null;
    unset($_SESSION['flash']);
    return is_array($flash) ? $flash : null;
}

// --------------------------------------------------------------- accounts
function sp_users_schema(): void
{
    static $ready = false;
    if ($ready) {
        return;
    }
    $pdo = sp_db();
    if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql') {
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS dashboard_users (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(60) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(10) NOT NULL DEFAULT \'user\',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_username (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        );
    } else {
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS dashboard_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT \'user\',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )',
        );
    }
    $ready = true;
}

/** User names are kept in lower case so "Admin" and "admin" are one account. */
function sp_clean_username(string $username): string
{
    return mb_strtolower(trim($username));
}

function sp_username_problem(string $username): ?string
{
    if (!preg_match('/^[a-z0-9._-]{3,40}$/', $username)) {
        return 'A user name is 3 to 40 letters, digits, dots, dashes or underscores.';
    }
    return null;
}

function sp_password_problem(string $password): ?string
{
    if (strlen($password) < SP_PASSWORD_MIN) {
        return 'A password needs at least ' . SP_PASSWORD_MIN . ' characters.';
    }
    if (strlen($password) > 200) {
        return 'That password is too long.';
    }
    return null;
}

function sp_users_count(): int
{
    sp_users_schema();
    return (int) sp_db()->query('SELECT COUNT(*) FROM dashboard_users')->fetchColumn();
}

function sp_admin_count(): int
{
    sp_users_schema();
    return (int) sp_db()->query("SELECT COUNT(*) FROM dashboard_users WHERE role = 'admin'")->fetchColumn();
}

function sp_all_users(): array
{
    sp_users_schema();
    return sp_db()->query('SELECT id, username, role, created_at FROM dashboard_users ORDER BY role, username')->fetchAll();
}

function sp_user_by_id(int $id): ?array
{
    sp_users_schema();
    $stmt = sp_db()->prepare('SELECT id, username, role, created_at FROM dashboard_users WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function sp_user_by_name(string $username): ?array
{
    sp_users_schema();
    $stmt = sp_db()->prepare('SELECT id, username, role, password_hash FROM dashboard_users WHERE username = ?');
    $stmt->execute([sp_clean_username($username)]);
    $row = $stmt->fetch();
    return $row ?: null;
}

/** Create an account. Returns a message describing the problem, or null when it worked. */
function sp_create_user(string $username, string $password, string $role): ?string
{
    $username = sp_clean_username($username);
    $problem = sp_username_problem($username) ?? sp_password_problem($password);
    if ($problem !== null) {
        return $problem;
    }
    if (!isset(SP_ROLES[$role])) {
        return 'Choose Admin or User.';
    }
    if (sp_user_by_name($username)) {
        return "The user name \"$username\" is already taken.";
    }
    $stmt = sp_db()->prepare('INSERT INTO dashboard_users (username, password_hash, role) VALUES (?, ?, ?)');
    $stmt->execute([$username, password_hash($password, PASSWORD_DEFAULT), $role]);
    return null;
}

function sp_set_password(int $id, string $password): ?string
{
    $problem = sp_password_problem($password);
    if ($problem !== null) {
        return $problem;
    }
    $stmt = sp_db()->prepare('UPDATE dashboard_users SET password_hash = ? WHERE id = ?');
    $stmt->execute([password_hash($password, PASSWORD_DEFAULT), $id]);
    return null;
}

/** Change a role, never leaving the site without an admin. */
function sp_set_role(int $id, string $role): ?string
{
    $user = sp_user_by_id($id);
    if (!$user || !isset(SP_ROLES[$role])) {
        return 'That account or role does not exist.';
    }
    if ($user['role'] === 'admin' && $role !== 'admin' && sp_admin_count() <= 1) {
        return 'This is the only admin. Make another account an admin first.';
    }
    $stmt = sp_db()->prepare('UPDATE dashboard_users SET role = ? WHERE id = ?');
    $stmt->execute([$role, $id]);
    return null;
}

function sp_delete_user(int $id, int $actingUserId): ?string
{
    $user = sp_user_by_id($id);
    if (!$user) {
        return 'That account does not exist.';
    }
    if ($id === $actingUserId) {
        return 'You cannot delete the account you are signed in with.';
    }
    if ($user['role'] === 'admin' && sp_admin_count() <= 1) {
        return 'This is the only admin and cannot be deleted.';
    }
    $stmt = sp_db()->prepare('DELETE FROM dashboard_users WHERE id = ?');
    $stmt->execute([$id]);
    return null;
}

// ------------------------------------------------------- signing in and out
/** The signed-in account, read fresh from the table so a deleted or changed account takes effect at once. */
function sp_current_user(): ?array
{
    static $user = false;
    if ($user !== false) {
        return $user;
    }
    $user = null;
    if (!empty($_SESSION['user_id'])) {
        $user = sp_user_by_id((int) $_SESSION['user_id']);
        if (!$user) {
            unset($_SESSION['user_id'], $_SESSION['last_seen']);
        }
    }
    return $user;
}

function sp_is_admin(): bool
{
    return (sp_current_user()['role'] ?? '') === 'admin';
}

function sp_sign_in(array $user): void
{
    session_regenerate_id(true);
    $_SESSION['user_id'] = (int) $user['id'];
    $_SESSION['last_seen'] = time();
    $_SESSION['csrf'] = bin2hex(random_bytes(20));
}

function sp_sign_out(): void
{
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => $params['path'], 'secure' => $params['secure'], 'httponly' => true, 'samesite' => 'Lax']);
    }
    session_destroy();
}

function sp_visitor_address(): string
{
    $forwarded = trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''))[0]);
    return $forwarded !== '' ? $forwarded : (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

/** Failed sign-ins are counted in small files under php/cache, per visitor and per account. */
function sp_login_counter_file(string $key): string
{
    return SP_CACHE_DIR . '/login/' . sha1($key) . '.json';
}

function sp_login_failures(string $key): int
{
    $file = sp_login_counter_file($key);
    $data = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
    if (!is_array($data) || time() - (int) ($data['since'] ?? 0) > SP_LOGIN_WINDOW_SECONDS) {
        return 0;
    }
    return (int) ($data['count'] ?? 0);
}

function sp_login_note_failure(string $key): void
{
    $file = sp_login_counter_file($key);
    $data = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
    if (!is_array($data) || time() - (int) ($data['since'] ?? 0) > SP_LOGIN_WINDOW_SECONDS) {
        $data = ['since' => time(), 'count' => 0];
    }
    $data['count'] = (int) $data['count'] + 1;
    if (is_dir(dirname($file)) || @mkdir(dirname($file), 0755, true)) {
        @file_put_contents($file, json_encode($data), LOCK_EX);
    }
}

/**
 * Check a user name and password. Returns [account or null, message for the
 * person]. Wrong guesses are slowed down and, after too many, refused for
 * ten minutes.
 */
function sp_try_login(string $username, string $password): array
{
    $username = sp_clean_username($username);
    $visitorKey = 'visitor|' . $username . '|' . sp_visitor_address();
    $accountKey = 'account|' . $username;
    if (sp_login_failures($visitorKey) >= SP_LOGIN_MAX_PER_VISITOR || sp_login_failures($accountKey) >= SP_LOGIN_MAX_PER_ACCOUNT) {
        return [null, 'Too many wrong attempts. Wait ten minutes and try again.'];
    }
    $user = $username !== '' ? sp_user_by_name($username) : null;
    // Check a hash even for an unknown name, so the answer takes the same time
    // either way. This one is the hash of a random throwaway string.
    $hash = $user['password_hash'] ?? '$2y$10$istii/3TKv582H/m80fGV.rAnFIeEcwI1IGcGxrbmDW30cbaFpzzq';
    $ok = password_verify($password, $hash) && $user !== null;
    if (!$ok) {
        sp_login_note_failure($visitorKey);
        sp_login_note_failure($accountKey);
        usleep(400000);
        return [null, 'Wrong user name or password.'];
    }
    @unlink(sp_login_counter_file($visitorKey));
    if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
        sp_set_password((int) $user['id'], $password);
    }
    return [$user, ''];
}
