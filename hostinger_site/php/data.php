<?php
/**
 * Data layer for the PHP dashboard: reads price_history straight from the
 * database (the api/config.php connection), works out the latest price per
 * spare part, official-vs-Cashify matches, search, sorting and paging.
 *
 * A port of the data functions in dashboard.py, kept in the same order so
 * the two stay easy to compare.
 */
declare(strict_types=1);

const SP_DISPLAY_TIMEZONE = 'Asia/Kolkata';
const SP_SUPPORTED_BRANDS = [
    'Apple', 'Asus', 'Google', 'Honor', 'Infinix', 'iQOO', 'Mi', 'Motorola',
    'Nokia', 'Nothing', 'OnePlus', 'OPPO', 'POCO', 'realme', 'Samsung', 'vivo', 'Xiaomi',
];
const SP_PER_PAGE_OPTIONS = [25, 50, 100, 250];
const SP_HISTORY_PER_PAGE_OPTIONS = [10, 25, 50, 100];
const SP_HISTORY_PER_PAGE_DEFAULT = 10;
// Older Cashify rows used names the site API now reports differently.
const SP_LEGACY_PART_NAMES = ['Cashify - Motherboard' => 'Cashify - Motherboard Inspection', 'Cashify - BACK PANEL' => 'Cashify - Back Panel'];
const SP_COMPETITOR_BRAND_ALIASES = ['xiaomi' => 'mi', 'poco' => 'mi'];
const SP_SEARCH_BRAND_WORDS = ['apple', 'samsung', 'xiaomi', 'oppo', 'realme', 'oneplus', 'vivo', 'iqoo', 'motorola', 'moto'];
const SP_CACHE_DIR = __DIR__ . '/cache';

// ------------------------------------------------------------ configuration
function sp_config(): array
{
    static $config = null;
    if ($config === null) {
        // On the server the API folder sits next to this one (public_html/api).
        // In the repository it is ../hostinger_api, used when trying the site on a PC.
        $file = dirname(__DIR__) . '/api/config.php';
        if (!is_file($file)) {
            $file = dirname(__DIR__, 2) . '/hostinger_api/config.php';
        }
        if (!is_file($file)) {
            throw new RuntimeException('api/config.php is missing; copy api/config.example.php and fill it in');
        }
        $config = require $file;
        if (!is_array($config)) {
            throw new RuntimeException('api/config.php must return an array');
        }
    }
    return $config;
}

/** Same rule as api/index.php: accept a bare database name and fill in defaults. */
function sp_normalize_dsn(string $dsn, string $user): string
{
    if (!str_starts_with($dsn, 'mysql:')) {
        return $dsn;
    }
    $pairs = [];
    $bare = null;
    foreach (array_filter(array_map('trim', explode(';', substr($dsn, 6))), 'strlen') as $part) {
        if (str_contains($part, '=')) {
            [$key, $value] = explode('=', $part, 2);
            $pairs[strtolower(trim($key))] = trim($value);
        } elseif ($bare === null) {
            $bare = $part;
        }
    }
    if (empty($pairs['dbname'])) {
        $pairs['dbname'] = $bare ?? $user;
    }
    $pairs += ['host' => 'localhost', 'charset' => 'utf8mb4'];
    $out = [];
    foreach ($pairs as $key => $value) {
        $out[] = $key . '=' . $value;
    }
    return 'mysql:' . implode(';', $out);
}

function sp_db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $config = sp_config();
        $user = (string) ($config['user'] ?? '');
        $pdo = new PDO(sp_normalize_dsn((string) ($config['dsn'] ?? ''), $user), $user, (string) ($config['password'] ?? ''), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $pdo;
}

function sp_db_label(): string
{
    $dsn = (string) (sp_config()['dsn'] ?? '');
    if (str_starts_with($dsn, 'mysql:')) {
        return 'MySQL on ' . (preg_match('/host=([^;]+)/', $dsn, $m) ? $m[1] : 'localhost');
    }
    return 'local file ' . basename(substr($dsn, (int) strpos($dsn, ':') + 1));
}

// ------------------------------------------------------------- formatting
function sp_money($value, ?string $currency): string
{
    if ($value === null || $value === '') {
        return '-';
    }
    $prefix = $currency === 'INR' ? 'Rs ' : ($currency ? $currency . ' ' : '');
    return $prefix . number_format((float) round((float) $value), 0, '.', ',');
}

function sp_parse_iso($value): ?DateTimeImmutable
{
    if (!$value) {
        return null;
    }
    try {
        return new DateTimeImmutable((string) $value, new DateTimeZone('UTC'));
    } catch (Throwable) {
        return null;
    }
}

/** "28 Sep 2026, 11:17 AM" in India time, like the other editions. */
function sp_local_date($value): string
{
    $date = sp_parse_iso($value);
    return $date ? $date->setTimezone(new DateTimeZone(SP_DISPLAY_TIMEZONE))->format('d M Y, h:i A') : (string) ($value ?? '');
}

/** "30 Sep, 06:03 PM" in India time, for tight spaces. */
function sp_local_date_short($value): string
{
    $date = sp_parse_iso($value);
    return $date ? $date->setTimezone(new DateTimeZone(SP_DISPLAY_TIMEZONE))->format('d M, h:i A') : (string) ($value ?? '');
}

function sp_local_day($value): string
{
    $date = $value instanceof DateTimeInterface ? $value : sp_parse_iso($value);
    return $date ? $date->setTimezone(new DateTimeZone(SP_DISPLAY_TIMEZONE))->format('Y-m-d') : '';
}

// ---------------------------------------------------------- name matching
/** Lowercase, replace non-breaking spaces and collapse whitespace. */
function sp_clean_text($value): string
{
    static $memo = [];
    $text = (string) ($value ?? '');
    if (isset($memo[$text])) {
        return $memo[$text];
    }
    $clean = mb_strtolower(trim(preg_replace('/\s+/u', ' ', str_replace("\xC2\xA0", ' ', $text)) ?? $text));
    if (count($memo) < 60000) {
        $memo[$text] = $clean;
    }
    return $clean;
}

/** Display text with non-breaking spaces and doubled whitespace removed. */
function sp_clean_label($value): string
{
    $text = (string) ($value ?? '');
    return trim(preg_replace('/\s+/u', ' ', str_replace("\xC2\xA0", ' ', $text)) ?? $text);
}

function sp_brand_key($brand): string
{
    $key = sp_clean_text($brand);
    return SP_COMPETITOR_BRAND_ALIASES[$key] ?? $key;
}

/** Canonical model name shared by every source. $loose drops a trailing "5G". */
function sp_model_key($model, bool $loose = false): string
{
    static $strict = [];
    static $looseMemo = [];
    $text = (string) ($model ?? '');
    if (!isset($strict[$text])) {
        $key = preg_replace('/^(?:xt\d{4}(?:-\d+)?\s+)?(?:(?:apple|samsung|xiaomi|oppo|realme|oneplus|vivo|iqoo|motorola|moto)\s+)*/', '', sp_clean_text($text)) ?? '';
        $key = preg_replace('/iphone se\s*\(?(\d)(?:st|nd|rd|th) generation\)?/', 'iphone se gen $1', $key) ?? $key;
        $key = preg_replace_callback('/iphone se (2016|2020|2022)$/', fn ($m) => 'iphone se gen ' . ['2016' => '1', '2020' => '2', '2022' => '3'][$m[1]], $key) ?? $key;
        if ($key === 'iphone se') {
            $key = 'iphone se gen 1';
        }
        // Samsung writes "Galaxy Z Fold7"; Cashify writes "Galaxy Z Fold 7".
        $strict[$text] = preg_replace('/\b(fold|flip|note)\s+(?=\d)/', '$1', $key) ?? $key;
        $looseMemo[$text] = preg_replace('/\s*\(?5g\)?$/', '', $strict[$text]) ?? $strict[$text];
    }
    return $loose ? $looseMemo[$text] : $strict[$text];
}

function sp_matches_search(array $row, string $search, array $extra = []): bool
{
    $needle = sp_clean_text($search);
    $model = (string) ($row['model'] ?? '');
    $hay = implode(' ', array_merge(
        [sp_clean_text($row['brand'] ?? ''), sp_clean_text($model), sp_clean_text($row['part'] ?? ''), sp_clean_text($row['price'] ?? ''), sp_model_key($model)],
        array_map('sp_clean_text', $extra),
    ));
    if ($needle === '' || str_contains($hay, $needle)) {
        return true;
    }
    // Fall back to the canonical model name, so "Apple iPhone SE 2022" finds
    // "iPhone SE (3rd generation)". A brand named in the search must still match.
    $key = sp_model_key($search);
    if ($key === '' || !str_contains(sp_model_key($model), $key)) {
        return false;
    }
    $prefix = str_ends_with($needle, $key)
        ? preg_split('/\s+/', trim(substr($needle, 0, strlen($needle) - strlen($key))), -1, PREG_SPLIT_NO_EMPTY)
        : [];
    $named = [];
    foreach ($prefix as $word) {
        if (in_array($word, SP_SEARCH_BRAND_WORDS, true)) {
            $named[$word === 'moto' ? 'motorola' : sp_brand_key($word)] = true;
        }
    }
    return !$named || isset($named[sp_brand_key($row['brand'] ?? '')]);
}

function sp_price_source(array $row): string
{
    $part = (string) ($row['part'] ?? '');
    $url = (string) ($row['url'] ?? '');
    if (str_starts_with($part, 'Cashify - ') || str_contains($url, 'cashify.in')) {
        return 'Cashify';
    }
    return (string) ($row['brand'] ?? '') ?: 'Official';
}

/** Fold vendor-specific part names into a shared category, or null. */
function sp_part_category($part): ?string
{
    static $memo = [];
    $text = (string) ($part ?? '');
    if (array_key_exists($text, $memo)) {
        return $memo[$text];
    }
    $name = mb_strtolower($text);
    if (str_starts_with($name, 'cashify - ')) {
        $name = substr($name, strlen('cashify - '));
    }
    $name = str_replace(['-', '（', '）'], [' ', ' (', ')'], $name);
    $has = function (string ...$words) use ($name): bool {
        foreach ($words as $word) {
            if (str_contains($name, $word)) {
                return true;
            }
        }
        return false;
    };
    $category = null;
    if ($has('cable', 'adapter', 'charger', 'headset', 'cleaning', 's pen', 'sim tray', 'component repair', 'inspection')) {
        $category = null;
    } elseif (str_contains($name, 'camera')) {
        $category = str_contains($name, 'front') ? 'Front Camera' : 'Back Camera';
    } elseif ($has('proximity')) {
        $category = 'Proximity Sensor';
    } elseif ($has('aux', 'headphone', 'earphone jack')) {
        $category = 'Aux Jack';
    } elseif ($has('receiver', 'earpiece')) {
        $category = 'Receiver';
    } elseif ($has('speaker')) {
        $category = 'Speaker';
    } elseif ($has('mic')) {
        $category = 'Mic';
    } elseif ($has('charging', 'usb port', 'sub board', 'pcb sb')) {
        $category = 'Charging Jack';
    } elseif ($has('motherboard', 'mainboard', 'main board', 'mother board', 'pcb mb', 'logic board')) {
        $category = 'Motherboard';
    } elseif ($has('sub screen', 'cover screen', 'cover display', 'outer screen', 'outer display', 'cli display', 'secondary display')) {
        $category = 'Cover Screen';
    } elseif ($has('screen', 'display', 'lcd', 'lcm', 'touch panel')) {
        $category = 'Screen';
    } elseif ($has('back cover', 'back glass', 'battery cover', 'backcover', 'rear cover', 'rear glass', 'back panel')) {
        $category = 'Back Cover';
    } elseif ($has('battery')) {
        $category = 'Battery';
    }
    return $memo[$text] = $category;
}

function sp_is_recent_enough($dateValue, $newest, int $windowHours = 36): bool
{
    $checked = sp_parse_iso($dateValue);
    $latest = sp_parse_iso($newest);
    if (!$checked || !$latest) {
        return true;
    }
    return $latest->getTimestamp() - $checked->getTimestamp() <= $windowHours * 3600;
}

/** For every latest price, the latest prices for the same model and category from other sources. */
function sp_attach_competitor_prices(array &$latest): void
{
    $strict = [];
    $loose = [];
    foreach ($latest as $i => &$row) {
        $row['source'] = sp_price_source($row);
        $row['brand_key'] = sp_brand_key($row['brand']);
        $row['model_key'] = sp_model_key($row['model']);
        $row['category'] = sp_part_category($row['part']);
        $row['competitors'] = [];
        if ($row['category'] !== null) {
            $strict[$row['brand_key'] . '|' . $row['model_key'] . '|' . $row['category']][] = $i;
            $loose[$row['brand_key'] . '|' . sp_model_key($row['model'], true) . '|' . $row['category']][] = $i;
        }
    }
    unset($row);

    $others = function (array $candidates, array $row) use ($latest): array {
        $seen = [];
        $found = [];
        foreach ($candidates as $j) {
            $other = $latest[$j];
            $tag = $other['source'] . '|' . $other['part'];
            if ($other['source'] === $row['source'] || isset($seen[$tag])) {
                continue;
            }
            $seen[$tag] = true;
            $found[] = [
                'source' => $other['source'], 'part' => $other['part'], 'price_value' => $other['price_value'],
                'currency' => $other['currency'], 'date' => $other['date'], 'url' => $other['url'],
            ];
        }
        // Keep only the parts each source refreshed in its most recent check, so
        // stale part names (an old shortlist name) drop out.
        $newest = [];
        foreach ($found as $other) {
            $newest[$other['source']] = max($newest[$other['source']] ?? '', (string) ($other['date'] ?? ''));
        }
        $found = array_values(array_filter($found, fn ($other) => sp_is_recent_enough($other['date'], $newest[$other['source']])));
        usort($found, fn ($a, $b) => strcmp($a['source'], $b['source']) ?: strcmp($a['part'], $b['part']));
        return $found;
    };

    foreach ($latest as &$row) {
        if ($row['category'] === null) {
            continue;
        }
        $found = $others($strict[$row['brand_key'] . '|' . $row['model_key'] . '|' . $row['category']] ?? [], $row);
        if (!$found) {
            $found = $others($loose[$row['brand_key'] . '|' . sp_model_key($row['model'], true) . '|' . $row['category']] ?? [], $row);
        }
        $row['competitors'] = $found;
    }
    unset($row);
}

/**
 * The most recent scrape: how many prices it refreshed, and when. Counting
 * back from the newest price, rows belong to the same scrape for as long as
 * consecutive check times are less than $gapMinutes apart.
 */
function sp_last_update(array $latest, int $gapMinutes = 15): array
{
    $stamps = [];
    $newestDate = null;
    foreach ($latest as $row) {
        $time = strtotime((string) ($row['date'] ?? ''));
        if ($time !== false) {
            $stamps[] = $time;
            if ($newestDate === null || $time > $newestDate[0]) {
                $newestDate = [$time, $row['date']];
            }
        }
    }
    if (!$stamps) {
        return ['count' => 0, 'date' => null];
    }
    rsort($stamps);
    $count = 1;
    for ($i = 1, $n = count($stamps); $i < $n; $i++) {
        if ($stamps[$i - 1] - $stamps[$i] > $gapMinutes * 60) {
            break;
        }
        $count++;
    }
    return ['count' => $count, 'date' => $newestDate[1]];
}

/** Tag consecutive rows sharing (brand, model) so the page can collapse them. */
function sp_group_by_model(array $rows): array
{
    $rows = array_values($rows);
    $count = count($rows);
    $grouped = [];
    $groupIndex = -1;
    for ($i = 0; $i < $count;) {
        $key = $rows[$i]['brand_key'] . '|' . $rows[$i]['model_key'];
        $j = $i;
        while ($j < $count && $rows[$j]['brand_key'] . '|' . $rows[$j]['model_key'] === $key) {
            $j++;
        }
        $groupIndex++;
        $slice = array_slice($rows, $i, $j - $i);
        $sources = count(array_unique(array_column($slice, 'source')));
        // Title the accordion with the brand's own model name when we have it.
        $label = $slice[0]['model'];
        foreach ($slice as $candidate) {
            if ($candidate['source'] !== 'Cashify') {
                $label = $candidate['model'];
                break;
            }
        }
        for ($k = $i; $k < $j; $k++) {
            $grouped[] = [
                'row' => $rows[$k], 'groupStart' => $k === $i, 'groupSize' => $j - $i, 'groupId' => 'g' . $groupIndex,
                'groupSources' => $sources, 'groupLabel' => $label,
            ];
        }
        $i = $j;
    }
    return $grouped;
}

function sp_page_info(int $total, int $page, int $perPage, int $window = 2): array
{
    $totalPages = max(1, (int) ceil($total / max(1, $perPage)));
    $page = min(max($page, 1), $totalPages);
    $start = ($page - 1) * $perPage;
    $end = min($start + $perPage, $total);
    $numbers = [1 => true, $totalPages => true];
    for ($p = $page - $window; $p <= $page + $window; $p++) {
        if ($p >= 1 && $p <= $totalPages) {
            $numbers[$p] = true;
        }
    }
    $pageNumbers = array_keys($numbers);
    sort($pageNumbers);
    return [
        'page' => $page, 'per_page' => $perPage, 'total' => $total, 'total_pages' => $totalPages,
        'slice_start' => $start, 'slice_end' => $end, 'start' => $total ? $start + 1 : 0, 'end' => $end,
        'has_prev' => $page > 1, 'has_next' => $page < $totalPages,
        'prev_page' => max(1, $page - 1), 'next_page' => min($totalPages, $page + 1), 'page_numbers' => $pageNumbers,
    ];
}

// ---------------------------------------------------------------- loading
function sp_status(PDO $pdo): array
{
    $row = $pdo->query('SELECT COUNT(*) AS count, MAX(id) AS max_id, MAX(date) AS max_date FROM price_history')->fetch();
    return ['count' => (int) $row['count'], 'max_id' => (int) ($row['max_id'] ?? 0), 'max_date' => $row['max_date']];
}

/** The newest successful row for every (brand, model, part), straight from SQL. */
function sp_query_latest(PDO $pdo): array
{
    return $pdo->query(
        'SELECT p.date, p.brand, p.model, p.part, p.price, p.price_value, p.currency, p.status, p.error, p.url
         FROM price_history p
         JOIN (SELECT brand, model, part, MAX(date) AS date FROM price_history WHERE status = \'ok\' GROUP BY brand, model, part) m
           ON m.brand = p.brand AND m.model = p.model AND m.part = p.part AND m.date = p.date
         WHERE p.status = \'ok\'',
    )->fetchAll();
}

/**
 * Latest prices with competitor matches plus the picker lists, cached on
 * disk until the table changes (row count or max id), so a page load is one
 * cheap status query plus a file read.
 */
function sp_load_price_data(): array
{
    static $data = null;
    if ($data !== null) {
        return $data;
    }
    $pdo = sp_db();
    $status = sp_status($pdo);
    $stamp = 'v2|' . $status['count'] . '|' . $status['max_id'];
    $cacheFile = SP_CACHE_DIR . '/latest.ser';
    if (is_file($cacheFile)) {
        $cached = @unserialize((string) file_get_contents($cacheFile), ['allowed_classes' => false]);
        if (is_array($cached) && ($cached['stamp'] ?? null) === $stamp) {
            return $data = $cached;
        }
    }

    $byKey = [];
    foreach (sp_query_latest($pdo) as $row) {
        $row['part'] = SP_LEGACY_PART_NAMES[$row['part']] ?? $row['part'];
        $key = $row['brand'] . '|' . $row['model'] . '|' . $row['part'];
        if (!isset($byKey[$key]) || strcmp((string) $row['date'], (string) $byKey[$key]['date']) > 0) {
            $byKey[$key] = $row;
        }
    }
    $latest = array_values($byKey);
    unset($byKey);
    foreach ($latest as &$row) {
        $row['price_value'] = $row['price_value'] === null || $row['price_value'] === '' ? null : (float) $row['price_value'];
        $row['day'] = sp_local_day($row['date']);
    }
    unset($row);
    sp_attach_competitor_prices($latest);
    usort($latest, fn ($a, $b) => strcmp($a['brand_key'], $b['brand_key'])
        ?: strcmp($a['model_key'], $b['model_key'])
        ?: (($a['source'] === 'Cashify') <=> ($b['source'] === 'Cashify'))
        ?: strcmp($a['brand'], $b['brand'])
        ?: strcmp($a['part'], $b['part']));

    $modelNames = [];
    foreach ($latest as $row) {
        $modelNames[$row['brand_key'] . '|' . $row['model_key']] ??= sp_clean_label($row['model']);
    }
    $modelOptions = array_values(array_unique(array_values($modelNames)));
    usort($modelOptions, 'strcasecmp');
    $suggestions = array_values(array_unique(array_map(fn ($row) => $row['model'] . ' - ' . $row['part'], $latest)));
    sort($suggestions, SORT_STRING);
    $brands = array_values(array_unique(array_merge(SP_SUPPORTED_BRANDS, $pdo->query('SELECT DISTINCT brand FROM price_history')->fetchAll(PDO::FETCH_COLUMN))));
    usort($brands, 'strcasecmp');

    $data = [
        'stamp' => $stamp, 'source' => sp_db_label(), 'total_rows' => $status['count'], 'latest' => $latest,
        'last_update' => sp_last_update($latest),
        'brands' => $brands, 'model_options' => $modelOptions, 'suggestions' => array_slice($suggestions, 0, 500),
    ];
    if (is_dir(SP_CACHE_DIR) || @mkdir(SP_CACHE_DIR, 0755, true)) {
        $tmp = $cacheFile . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, serialize($data)) !== false) {
            @rename($tmp, $cacheFile);
        }
    }
    return $data;
}

/** Recent checks straight from SQL: filtered, newest first, one page. */
function sp_history(PDO $pdo, array $filters, array $modelPairs, int $page, int $perPage): array
{
    $where = [];
    $params = [];
    if ($filters['brands']) {
        $where[] = 'LOWER(brand) IN (' . implode(',', array_fill(0, count($filters['brands']), '?')) . ')';
        foreach ($filters['brands'] as $brand) {
            $params[] = mb_strtolower($brand);
        }
    }
    if ($filters['status'] === 'ok' || $filters['status'] === 'error') {
        $where[] = 'status = ?';
        $params[] = $filters['status'];
    }
    if ($filters['search'] !== '') {
        $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], sp_clean_text($filters['search'])) . '%';
        $conditions = [];
        foreach (['brand', 'model', 'part', 'price', 'status'] as $column) {
            $conditions[] = "LOWER($column) LIKE ?";
            $params[] = $like;
        }
        // Models the search matched by canonical name (e.g. "iPhone SE 2022").
        foreach (array_slice($modelPairs, 0, 300) as [$brand, $model]) {
            $conditions[] = '(brand = ? AND model = ?)';
            $params[] = $brand;
            $params[] = $model;
        }
        $where[] = '(' . implode(' OR ', $conditions) . ')';
    }
    $sqlWhere = $where ? ' WHERE ' . implode(' AND ', $where) : '';
    $count = $pdo->prepare("SELECT COUNT(*) FROM price_history$sqlWhere");
    $count->execute($params);
    $total = (int) $count->fetchColumn();
    $pagination = sp_page_info($total, $page, $perPage);
    $limit = (int) $pagination['per_page'];
    $offset = (int) $pagination['slice_start'];
    $stmt = $pdo->prepare(
        "SELECT date, brand, model, part, price, price_value, currency, status, error, url FROM price_history$sqlWhere
         ORDER BY date DESC, id DESC LIMIT $limit OFFSET $offset",
    );
    $stmt->execute($params);
    return [$stmt->fetchAll(), $pagination];
}

function sp_sort_value(array $row, string $sort)
{
    return match ($sort) {
        'brand' => mb_strtolower((string) $row['brand']),
        'model' => $row['model_key'],
        'part' => mb_strtolower((string) $row['part']),
        'price' => $row['price_value'] ?? -1.0,
        default => (string) ($row['date'] ?? ''),
    };
}

function sp_load_dashboard(array $options = []): array
{
    $search = trim((string) ($options['search'] ?? ''));
    $selectedBrands = $options['selectedBrands'] ?? [];
    $page = (int) ($options['page'] ?? 1);
    $perPage = (int) ($options['perPage'] ?? 100);
    $status = (string) ($options['status'] ?? '');
    $sort = (string) ($options['sort'] ?? 'date');
    $sortDir = (string) ($options['sortDir'] ?? 'desc');
    $paginate = $options['paginate'] ?? true;
    $withHistory = $options['withHistory'] ?? true;
    $historyPage = (int) ($options['historyPage'] ?? 1);
    $historyPerPage = (int) ($options['historyPerPage'] ?? SP_HISTORY_PER_PAGE_DEFAULT);

    $cached = sp_load_price_data();
    $allLatest = $cached['latest'];
    $latest = $allLatest;
    $selectedLower = array_flip(array_map('mb_strtolower', $selectedBrands));
    if ($selectedLower) {
        $latest = array_values(array_filter($latest, fn ($row) => isset($selectedLower[mb_strtolower((string) $row['brand'])])));
    }
    if ($search !== '') {
        $latest = array_values(array_filter($latest, fn ($row) => sp_matches_search($row, $search)));
    }

    $sortKey = in_array($sort, ['brand', 'model', 'part', 'price', 'date'], true) ? $sort : 'date';
    $reverse = $sortDir !== 'asc';
    usort($latest, function ($a, $b) use ($sortKey, $reverse) {
        $x = sp_sort_value($a, $sortKey);
        $y = sp_sort_value($b, $sortKey);
        $result = is_float($x) || is_int($x) ? $x <=> $y : strcmp((string) $x, (string) $y);
        return $reverse ? -$result : $result;
    });
    if ($sortKey === 'date') {
        // Keep every model's rows together while ordering models by their most recent check.
        $firstSeen = [];
        foreach ($latest as $row) {
            $firstSeen[$row['brand_key'] . '|' . $row['model_key']] ??= count($firstSeen);
        }
        usort($latest, fn ($a, $b) => $firstSeen[$a['brand_key'] . '|' . $a['model_key']] <=> $firstSeen[$b['brand_key'] . '|' . $b['model_key']]);
    }

    $latestTotal = count($latest);
    $perPage = in_array($perPage, SP_PER_PAGE_OPTIONS, true) ? $perPage : 100;
    if (!$paginate) {
        $perPage = max($latestTotal, 1);
        $page = 1;
    }
    $pagination = sp_page_info($latestTotal, $page, $perPage);
    $pagedLatest = sp_group_by_model(array_slice($latest, $pagination['slice_start'], $pagination['slice_end'] - $pagination['slice_start']));

    $history = [];
    $historyPagination = sp_page_info(0, 1, SP_HISTORY_PER_PAGE_DEFAULT);
    if ($withHistory) {
        if (!in_array($historyPerPage, SP_HISTORY_PER_PAGE_OPTIONS, true)) {
            $historyPerPage = SP_HISTORY_PER_PAGE_DEFAULT;
        }
        $pairs = [];
        if ($search !== '') {
            foreach ($latest as $row) {
                $pairs[$row['brand'] . '|' . $row['model']] = [$row['brand'], $row['model']];
            }
        }
        [$history, $historyPagination] = sp_history(
            sp_db(), ['brands' => $selectedBrands, 'status' => $status, 'search' => $search], array_values($pairs), $historyPage, $historyPerPage,
        );
    }

    $priced = array_values(array_filter(array_column($latest, 'price_value'), fn ($v) => $v !== null));
    $today = sp_local_day(new DateTimeImmutable('now', new DateTimeZone('UTC')));
    $updatedToday = 0;
    foreach ($allLatest as $row) {
        if (($row['day'] ?? '') === $today) {
            $updatedToday++;
        }
    }
    $modelKeys = [];
    foreach ($latest as $row) {
        $modelKeys[$row['brand_key'] . '|' . $row['model_key']] = true;
    }

    return [
        'latest' => $pagedLatest,
        'history' => $history,
        'history_pagination' => $historyPagination,
        'brands' => $cached['brands'],
        'per_page_options' => SP_PER_PAGE_OPTIONS,
        'history_per_page_options' => SP_HISTORY_PER_PAGE_OPTIONS,
        'suggestions' => $cached['suggestions'],
        'model_options' => $cached['model_options'],
        'sort' => $sortKey, 'sort_dir' => $reverse ? 'desc' : 'asc', 'selected_status' => $status, 'selected_brands' => $selectedBrands,
        'pagination' => $pagination,
        'stats' => [
            'tracked' => $latestTotal,
            'brands' => count(array_unique(array_column($latest, 'brand'))),
            'models' => count($modelKeys),
            'average_value' => $priced ? array_sum($priced) / count($priced) : null,
            'updated_today' => $updatedToday,
            'last_update' => $cached['last_update'] ?? sp_last_update($allLatest),
        ],
        'data_source' => $cached['source'],
    ];
}

/** Rows for an export plus a short name for the file. */
function sp_export_rows(string $scope, string $model, array $filters): array
{
    if ($scope === 'view') {
        $data = sp_load_dashboard([
            'search' => $filters['search'], 'selectedBrands' => $filters['brands'], 'status' => $filters['status'],
            'sort' => 'model', 'sortDir' => 'asc', 'paginate' => false, 'withHistory' => false,
        ]);
        return [array_column($data['latest'], 'row'), 'current_view'];
    }
    $data = sp_load_dashboard(['sort' => 'model', 'sortDir' => 'asc', 'paginate' => false, 'withHistory' => false]);
    $rows = array_column($data['latest'], 'row');
    if ($scope !== 'model' || trim($model) === '') {
        return [$rows, 'all_models'];
    }
    $wanted = sp_model_key($model);
    $wantedLoose = sp_model_key($model, true);
    $chosen = array_values(array_filter($rows, fn ($row) => $row['model_key'] === $wanted));
    if (!$chosen) {
        $chosen = array_values(array_filter($rows, fn ($row) => sp_model_key($row['model'], true) === $wantedLoose));
    }
    if (!$chosen) {
        $chosen = array_values(array_filter($rows, fn ($row) => sp_matches_search($row, $model)));
    }
    $label = trim(preg_replace('/[^a-z0-9]+/', '_', mb_strtolower(sp_clean_label($model))) ?? '', '_') ?: 'model';
    return [$chosen, $label];
}
