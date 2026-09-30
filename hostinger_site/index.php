<?php
/**
 * Spareprice dashboard for Hostinger shared hosting (PHP + MySQL).
 *
 * Upload this folder to public_html: the dashboard runs at / and the price
 * API at /api (api/index.php), sharing api/config.php. Scrape buttons are
 * forwarded to the Render app (see php/jobs.php).
 *
 * Routes (see .htaccess):
 *   /                              the dashboard
 *   /models.json                   model names for the export picker
 *   /export.csv, /export.xlsx      exports (scope=all|view|model)
 *   /check-now, /discover-all,
 *   /discover-scope (POST)         start a scrape on the scraper host
 *   /job-status                    progress of that scrape
 * Every route also works as index.php?action=<name>.
 */
declare(strict_types=1);

require __DIR__ . '/php/data.php';
require __DIR__ . '/php/render.php';
require __DIR__ . '/php/exports.php';
require __DIR__ . '/php/jobs.php';

const SP_SCRAPE_BRANDS = ['all', 'apple', 'samsung', 'oppo', 'realme', 'oneplus', 'mi', 'vivo', 'iqoo', 'motorola', 'cashify'];

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

function sp_send_download(string $filename, string $contentType, string $bytes): void
{
    header('Content-Type: ' . $contentType);
    header('Content-Disposition: attachment; filename=' . $filename);
    header('Content-Length: ' . strlen($bytes));
    echo $bytes;
}

$action = strtolower(trim((string) ($_GET['action'] ?? '')));
$action = str_replace('.json', '', $action);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    switch ($action) {
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
            if ($method !== 'POST') {
                header('Location: index.php');
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
                header('Location: index.php');
            }
            break;

        case 'job-status':
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
            header('Cache-Control: no-store');
            echo sp_render_page($data + [
                'job' => sp_job_state(),
                'search' => $filters['search'],
                'selected_per_page' => $data['pagination']['per_page'],
                'active_filters' => sp_active_filters($filters),
                'sort_headers' => sp_sort_headers($filters),
                'latest_links' => sp_pager_links($data['pagination'], $baseQuery, 'page', ''),
                'history_links' => sp_pager_links($data['history_pagination'], $historyQuery, 'hpage', 'recent-checks'),
                'urls' => [
                    'index' => 'index.php',
                    'css' => 'public/dashboard.css',
                    'js' => 'public/dashboard.js',
                    'models_json' => 'index.php?action=models',
                    'export_all' => sp_url('index.php?action=export.xlsx', ['scope' => 'all']),
                    'export_view' => sp_url('index.php?action=export.xlsx', ['scope' => 'view'] + $baseQuery),
                    'export_base' => 'index.php',
                    'check_now' => 'index.php?action=check-now',
                    'discover_scope' => 'index.php?action=discover-scope',
                ],
            ]);
    }
} catch (Throwable $error) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Dashboard error: ' . $error->getMessage();
}
