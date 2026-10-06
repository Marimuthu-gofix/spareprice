<?php
/**
 * Spareprice dashboard for Hostinger shared hosting (PHP + MySQL).
 *
 * Upload this folder to public_html: the dashboard runs at / and the price
 * API at /api (api/index.php), sharing api/config.php.
 *
 * Everyone signs in (php/auth.php). An admin sees prices, downloads Excel,
 * starts scrapes and manages accounts; a user sees prices and downloads
 * Excel. The very first visit creates the admin account.
 *
 * Routes (see .htaccess); every one also works as index.php?action=<name>:
 *   /                              the dashboard
 *   ?action=login | logout         sign in and out
 *   ?action=setup                  first visit only: create the admin
 *   ?action=account                change your own password
 *   ?action=users                  admin: add, change and delete accounts
 *   /models.json                   model names for the export picker
 *   /export.csv, /export.xlsx      exports (scope=all|view|model)
 *   /check-now, /discover-all,
 *   /discover-scope (POST)         admin: start a scrape (php/jobs.php)
 *   /job-status                    admin: progress of that scrape
 */
declare(strict_types=1);

require __DIR__ . '/php/data.php';
require __DIR__ . '/php/render.php';
require __DIR__ . '/php/exports.php';
require __DIR__ . '/php/jobs.php';
require __DIR__ . '/php/auth.php';
require __DIR__ . '/php/auth_views.php';

const SP_SCRAPE_BRANDS = ['all', 'apple', 'samsung', 'oppo', 'realme', 'oneplus', 'mi', 'vivo', 'iqoo', 'motorola', 'cashify'];
const SP_SCRAPE_ACTIONS = ['check-now', 'discover-all', 'discover-scope'];

function sp_wants_json(): bool
{
    return trim((string) ($_SERVER['HTTP_ACCEPT'] ?? '')) === 'application/json';
}

function sp_send_json(int $status, $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function sp_send_html(string $html, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Frame-Options: DENY');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    echo $html;
}

function sp_redirect(string $to): void
{
    header('Cache-Control: no-store');
    header('Location: ' . $to);
}

/**
 * A style or script address that changes whenever the file does. The host
 * lets browsers keep these files for a week, so without this a visitor goes
 * on seeing the old look after an upload.
 */
function sp_asset(string $path): string
{
    $file = __DIR__ . '/' . $path;
    return is_file($file) ? $path . '?v=' . filemtime($file) : $path;
}

function sp_send_download(string $filename, string $contentType, string $bytes): void
{
    header('Content-Type: ' . $contentType);
    header('Content-Disposition: attachment; filename=' . $filename);
    header('Content-Length: ' . strlen($bytes));
    header('Cache-Control: no-store');
    echo $bytes;
}

$action = strtolower(trim((string) ($_GET['action'] ?? '')));
$action = str_replace('.json', '', $action);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$isPost = $method === 'POST';
// Routes the page script calls and expects JSON back from.
$isDataRoute = sp_wants_json() || in_array($action, ['models', 'job-status'], true);

try {
    sp_session_start();

    // ------------------------------------- first visit: nobody can administer yet
    // (also the way back in if the admin row is ever deleted in phpMyAdmin)
    if (sp_admin_count() === 0) {
        if ($isDataRoute) {
            sp_send_json(401, ['error' => 'The site has no accounts yet. Open it in a browser to create the admin.']);
            return;
        }
        if ($action === 'setup' && $isPost) {
            $username = (string) ($_POST['username'] ?? '');
            $password = (string) ($_POST['password'] ?? '');
            $problem = null;
            if (!sp_csrf_ok()) {
                $problem = 'The form expired. Please try again.';
            } elseif (!hash_equals((string) (sp_config()['api_key'] ?? ''), (string) ($_POST['setup_code'] ?? ''))) {
                usleep(400000);
                $problem = 'The setup code is not the api_key from api/config.php.';
            } elseif ($password !== (string) ($_POST['password2'] ?? '')) {
                $problem = 'The two passwords are not the same.';
            } else {
                $problem = sp_create_user($username, $password, 'admin');
            }
            if ($problem === null) {
                sp_sign_in(sp_user_by_name($username));
                sp_flash('ok', 'The admin account is ready. Add other people under Accounts.');
                sp_redirect('index.php');
                return;
            }
            sp_send_html(sp_setup_page(['type' => 'error', 'text' => $problem], $username));
            return;
        }
        sp_send_html(sp_setup_page(sp_take_flash()));
        return;
    }
    if ($action === 'setup') {
        sp_redirect('index.php');
        return;
    }

    $user = sp_current_user();

    // ---------------------------------------------------------------- sign in
    if ($action === 'login') {
        if ($user) {
            sp_redirect('index.php');
            return;
        }
        if ($isPost) {
            $username = (string) ($_POST['username'] ?? '');
            if (!sp_csrf_ok()) {
                sp_send_html(sp_login_page(['type' => 'error', 'text' => 'The form expired. Please try again.'], $username));
                return;
            }
            [$account, $message] = sp_try_login($username, (string) ($_POST['password'] ?? ''));
            if ($account) {
                sp_sign_in($account);
                sp_redirect('index.php');
                return;
            }
            sp_send_html(sp_login_page(['type' => 'error', 'text' => $message], $username), 401);
            return;
        }
        sp_send_html(sp_login_page(sp_take_flash()));
        return;
    }

    if (!$user) {
        if ($isDataRoute) {
            sp_send_json(401, ['error' => 'Sign in first.', 'message' => 'Signed out. Reload the page and sign in.', 'running' => false]);
        } else {
            sp_redirect('index.php?action=login');
        }
        return;
    }

    // Every form a signed-in person submits must carry the page's token.
    if ($isPost && !sp_csrf_ok()) {
        if ($isDataRoute) {
            sp_send_json(403, ['error' => 'The page is out of date. Reload it and try again.', 'message' => 'The page is out of date. Reload it and try again.', 'running' => false]);
        } else {
            sp_flash('error', 'The form expired. Please try again.');
            sp_redirect('index.php');
        }
        return;
    }

    $isAdmin = sp_is_admin();

    switch ($action) {
        case 'logout':
            if ($isPost) {
                sp_sign_out();
            }
            sp_redirect('index.php?action=login');
            break;

        case 'account':
            if ($isPost) {
                $stored = sp_user_by_name($user['username']);
                $password = (string) ($_POST['password'] ?? '');
                if (!$stored || !password_verify((string) ($_POST['current'] ?? ''), $stored['password_hash'])) {
                    usleep(400000);
                    sp_flash('error', 'The current password is not right.');
                } elseif ($password !== (string) ($_POST['password2'] ?? '')) {
                    sp_flash('error', 'The two new passwords are not the same.');
                } elseif (($problem = sp_set_password((int) $user['id'], $password)) !== null) {
                    sp_flash('error', $problem);
                } else {
                    session_regenerate_id(true);
                    sp_flash('ok', 'Your password is changed.');
                }
                sp_redirect('index.php?action=account');
                break;
            }
            sp_send_html(sp_account_page($user, sp_take_flash()));
            break;

        case 'users':
            if (!$isAdmin) {
                sp_flash('error', 'Only an admin can manage accounts.');
                sp_redirect('index.php');
                break;
            }
            if ($isPost) {
                $id = (int) ($_POST['id'] ?? 0);
                $problem = match ((string) ($_POST['op'] ?? '')) {
                    'create' => sp_create_user((string) ($_POST['username'] ?? ''), (string) ($_POST['password'] ?? ''), (string) ($_POST['role'] ?? 'user')),
                    'role' => sp_set_role($id, (string) ($_POST['role'] ?? '')),
                    'password' => sp_user_by_id($id) ? sp_set_password($id, (string) ($_POST['password'] ?? '')) : 'That account does not exist.',
                    'delete' => sp_delete_user($id, (int) $user['id']),
                    default => 'Unknown request.',
                };
                $done = [
                    'create' => 'The account was added.', 'role' => 'The role was changed.',
                    'password' => 'The password was changed.', 'delete' => 'The account was deleted.',
                ][(string) ($_POST['op'] ?? '')] ?? 'Done.';
                sp_flash($problem === null ? 'ok' : 'error', $problem ?? $done);
                sp_redirect('index.php?action=users');
                break;
            }
            sp_send_html(sp_users_page($user, sp_all_users(), sp_take_flash()));
            break;

        case 'models':
            sp_send_json(200, sp_load_price_data()['model_options']);
            break;

        case 'export.csv':
            [$rows, $label] = sp_export_rows((string) ($_GET['scope'] ?? 'view'), (string) ($_GET['model'] ?? ''), sp_parse_filters($_GET));
            sp_send_download("spareprice_$label.csv", 'text/csv; charset=utf-8', sp_rows_to_csv($rows));
            break;

        case 'export.xlsx':
            [$rows, $label] = sp_export_rows((string) ($_GET['scope'] ?? 'all'), (string) ($_GET['model'] ?? ''), sp_parse_filters($_GET));
            $bytes = sp_rows_to_excel($rows);
            if ($bytes === null) {
                // No ZipArchive on this PHP: fall back to CSV so the export still works.
                sp_send_download("spareprice_$label.csv", 'text/csv; charset=utf-8', sp_rows_to_csv($rows));
            } else {
                sp_send_download("spareprice_$label.xlsx", 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', $bytes);
            }
            break;

        case 'check-now':
        case 'discover-all':
        case 'discover-scope':
            if (!$isAdmin) {
                sp_send_json(403, ['error' => 'Only an admin can start a scrape.', 'message' => 'Only an admin can start a scrape.', 'running' => false]);
                break;
            }
            if (!$isPost) {
                sp_redirect('index.php');
                break;
            }
            $brand = 'all';
            $model = '';
            if ($action === 'discover-scope') {
                $brand = strtolower(trim((string) ($_POST['scrape_brand'] ?? ''))) ?: 'all';
                $brand = in_array($brand, SP_SCRAPE_BRANDS, true) ? $brand : 'all';
                $model = trim((string) ($_POST['scrape_model'] ?? ''));
            }
            $github = sp_github_config();
            if ($github) {
                // Every button starts the GitHub workflow; "Check All Prices" is a full scrape.
                [$status, $state] = sp_start_github_job($github, $brand, $model);
            } else {
                $form = $action === 'discover-scope' ? ['scrape_brand' => $brand, 'scrape_model' => $model] : [];
                [$status, $state] = sp_proxy_job('/' . $action, 'POST', $form);
            }
            if (sp_wants_json()) {
                sp_send_json($status, sp_public_job_state($state));
            } else {
                sp_redirect('index.php');
            }
            break;

        case 'job-status':
            if (!$isAdmin) {
                sp_send_json(403, ['error' => 'Only an admin can see scrape progress.', 'message' => 'Only an admin can see scrape progress.', 'running' => false]);
                break;
            }
            $github = sp_github_config();
            [$status, $state] = $github ? sp_refresh_github_job($github) : sp_proxy_job('/job-status', 'GET');
            sp_send_json($status, sp_public_job_state($state));
            break;

        default:
            $filters = sp_parse_filters($_GET);
            $data = sp_load_dashboard([
                'search' => $filters['search'], 'selectedBrands' => $filters['brands'], 'page' => $filters['page'], 'perPage' => $filters['per_page'],
                'status' => $filters['status'], 'sort' => $filters['sort'], 'sortDir' => $filters['sort_dir'],
                'historyPage' => $filters['history_page'], 'historyPerPage' => $filters['history_per_page'],
            ]);
            $baseQuery = sp_build_query($filters);
            $historyQuery = sp_build_query($filters, ['page' => $data['pagination']['page']]);
            unset($historyQuery['hpage']);
            sp_send_html(sp_render_page($data + [
                'job' => $isAdmin ? sp_job_state() : sp_default_job_state(),
                'current_user' => $user,
                'can_scrape' => $isAdmin,
                'csrf' => sp_csrf_token(),
                'flash' => sp_take_flash(),
                'search' => $filters['search'],
                'selected_per_page' => $data['pagination']['per_page'],
                'active_filters' => sp_active_filters($filters),
                'sort_headers' => sp_sort_headers($filters),
                'latest_links' => sp_pager_links($data['pagination'], $baseQuery, 'page', ''),
                'history_links' => sp_pager_links($data['history_pagination'], $historyQuery, 'hpage', 'recent-checks'),
                'urls' => [
                    'index' => 'index.php',
                    'css' => sp_asset('public/dashboard.css'),
                    'js' => sp_asset('public/dashboard.js'),
                    'models_json' => 'index.php?action=models',
                    'export_all' => sp_url('index.php?action=export.xlsx', ['scope' => 'all']),
                    'export_view' => sp_url('index.php?action=export.xlsx', ['scope' => 'view'] + $baseQuery),
                    'export_base' => 'index.php',
                    'check_now' => 'index.php?action=check-now',
                    'discover_scope' => 'index.php?action=discover-scope',
                    'users' => 'index.php?action=users',
                    'account' => 'index.php?action=account',
                    'logout' => 'index.php?action=logout',
                ],
            ]));
    }
} catch (Throwable $error) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Dashboard error: ' . $error->getMessage();
}
