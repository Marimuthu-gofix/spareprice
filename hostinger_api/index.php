<?php
/**
 * Spareprice storage API for Hostinger Business (PHP + MySQL).
 *
 * Upload this folder to public_html/api (or any folder), copy
 * config.example.php to config.php and fill it in. The table is created on
 * first use.
 *
 * Routes (all JSON, all except /health need an X-API-Key header):
 *   GET  /health                       liveness check
 *   GET  /status                       {count, max_id, max_date}
 *   GET  /prices?after_id=0&limit=5000 rows with id > after_id, oldest first
 *   POST /prices  {"rows":[...]}       bulk insert; duplicates are ignored
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const MAX_ROWS_PER_REQUEST = 5000;
const ROW_FIELDS = ['date', 'brand', 'model', 'part', 'price', 'price_value', 'currency', 'url', 'status', 'error'];

function respond(int $code, array $body): void
{
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    respond(500, ['error' => 'config.php is missing; copy config.example.php and fill it in']);
}
$config = require $configFile;

// ---------------------------------------------------------------- routing
// All routes are a single word, so the last segment of the path is enough.
// This does not depend on SCRIPT_NAME or on where the folder is installed,
// which differ between Apache, LiteSpeed and PHP's built-in server.
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$route = strtolower(basename(trim($uri, '/')));
if ($route === '' || $route === 'index.php' || $route === 'api') {
    $route = '';
}
if (isset($_GET['route']) && is_string($_GET['route'])) {
    $route = strtolower(trim($_GET['route'], '/'));
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($route === 'health') {
    respond(200, ['status' => 'ok']);
}

// ------------------------------------------------------------------- auth
$expectedKey = (string) ($config['api_key'] ?? '');
$givenKey = (string) ($_SERVER['HTTP_X_API_KEY'] ?? '');
if ($expectedKey === '' || !hash_equals($expectedKey, $givenKey)) {
    respond(401, ['error' => 'Missing or invalid X-API-Key header']);
}

// --------------------------------------------------------------- database
try {
    $pdo = new PDO((string) $config['dsn'], (string) ($config['user'] ?? ''), (string) ($config['password'] ?? ''), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (PDOException $e) {
    respond(500, ['error' => 'Database connection failed: ' . $e->getMessage()]);
}
$driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
$isMysql = $driver === 'mysql';

function ensureSchema(PDO $pdo, bool $isMysql): void
{
    if ($isMysql) {
        $pdo->exec(<<<'SQL'
            CREATE TABLE IF NOT EXISTS price_history (
                id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                date        VARCHAR(40)  NOT NULL,
                brand       VARCHAR(100) NOT NULL,
                model       VARCHAR(191) NOT NULL,
                part        VARCHAR(191) NOT NULL,
                price       VARCHAR(255) NULL,
                price_value DOUBLE NULL,
                currency    VARCHAR(10) NULL,
                url         TEXT NOT NULL,
                status      VARCHAR(20) NOT NULL,
                error       TEXT NULL,
                created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_observation (date, brand, model, part),
                KEY idx_lookup (brand, model, part, date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        SQL);
    } else {
        // SQLite is only used for local testing of this API.
        $pdo->exec(<<<'SQL'
            CREATE TABLE IF NOT EXISTS price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL, brand TEXT NOT NULL, model TEXT NOT NULL, part TEXT NOT NULL,
                price TEXT, price_value REAL, currency TEXT, url TEXT NOT NULL,
                status TEXT NOT NULL, error TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (date, brand, model, part)
            )
        SQL);
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_lookup ON price_history (brand, model, part, date)');
    }
}

try {
    ensureSchema($pdo, $isMysql);
} catch (PDOException $e) {
    respond(500, ['error' => 'Could not create the price_history table: ' . $e->getMessage()]);
}

// ----------------------------------------------------------------- routes
try {
    if ($route === 'status' && $method === 'GET') {
        $row = $pdo->query('SELECT COUNT(*) AS count, MAX(id) AS max_id, MAX(date) AS max_date FROM price_history')->fetch();
        respond(200, [
            'count' => (int) $row['count'],
            'max_id' => $row['max_id'] === null ? 0 : (int) $row['max_id'],
            'max_date' => $row['max_date'],
        ]);
    }

    if ($route === 'prices' && $method === 'GET') {
        $afterId = max(0, (int) ($_GET['after_id'] ?? 0));
        $limit = (int) ($_GET['limit'] ?? MAX_ROWS_PER_REQUEST);
        $limit = max(1, min(MAX_ROWS_PER_REQUEST, $limit));
        $stmt = $pdo->prepare(
            'SELECT id, date, brand, model, part, price, price_value, currency, url, status, error
             FROM price_history WHERE id > :after ORDER BY id LIMIT ' . $limit
        );
        $stmt->bindValue(':after', $afterId, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();
        foreach ($rows as &$r) {
            $r['id'] = (int) $r['id'];
            $r['price_value'] = $r['price_value'] === null ? null : (float) $r['price_value'];
        }
        unset($r);
        $last = $rows ? $rows[count($rows) - 1]['id'] : $afterId;
        respond(200, ['rows' => $rows, 'next_after_id' => $last, 'has_more' => count($rows) === $limit]);
    }

    if ($route === 'prices' && $method === 'POST') {
        $raw = file_get_contents('php://input') ?: '';
        $body = json_decode($raw, true);
        if (!is_array($body) || !isset($body['rows']) || !is_array($body['rows'])) {
            respond(400, ['error' => 'Body must be JSON like {"rows": [...]}']);
        }
        $rows = $body['rows'];
        if (count($rows) > MAX_ROWS_PER_REQUEST) {
            respond(413, ['error' => 'At most ' . MAX_ROWS_PER_REQUEST . ' rows per request']);
        }
        $verb = $isMysql ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO';
        $stmt = $pdo->prepare(
            $verb . ' price_history (date, brand, model, part, price, price_value, currency, url, status, error)
             VALUES (:date, :brand, :model, :part, :price, :price_value, :currency, :url, :status, :error)'
        );
        $inserted = 0;
        $pdo->beginTransaction();
        foreach ($rows as $index => $row) {
            if (!is_array($row)) {
                $pdo->rollBack();
                respond(400, ['error' => "Row $index is not an object"]);
            }
            foreach (['date', 'brand', 'model', 'part', 'url', 'status'] as $required) {
                if (!isset($row[$required]) || trim((string) $row[$required]) === '') {
                    $pdo->rollBack();
                    respond(400, ['error' => "Row $index is missing '$required'"]);
                }
            }
            $stmt->execute([
                ':date' => (string) $row['date'],
                ':brand' => mb_substr((string) $row['brand'], 0, 100),
                ':model' => mb_substr((string) $row['model'], 0, 191),
                ':part' => mb_substr((string) $row['part'], 0, 191),
                ':price' => isset($row['price']) ? mb_substr((string) $row['price'], 0, 255) : null,
                ':price_value' => isset($row['price_value']) && $row['price_value'] !== '' ? (float) $row['price_value'] : null,
                ':currency' => isset($row['currency']) ? mb_substr((string) $row['currency'], 0, 10) : null,
                ':url' => (string) $row['url'],
                ':status' => mb_substr((string) $row['status'], 0, 20),
                ':error' => isset($row['error']) ? (string) $row['error'] : null,
            ]);
            $inserted += $stmt->rowCount() > 0 ? 1 : 0;
        }
        $pdo->commit();
        respond(200, ['received' => count($rows), 'inserted' => $inserted]);
    }
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    respond(500, ['error' => 'Database error: ' . $e->getMessage()]);
}

respond(404, ['error' => "Unknown route '$route'", 'routes' => ['GET /health', 'GET /status', 'GET /prices', 'POST /prices']]);
