<?php
/**
 * HTML helpers for the PHP dashboard: escaping, icons, URL building, the
 * sort headers and pager links, and the page itself (php/page.php).
 * Ported from the helpers in dashboard.py.
 */
declare(strict_types=1);

function e($value): string
{
    return htmlspecialchars((string) ($value ?? ''), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

const SP_ICONS = [
    'refresh' => '<path d="M3 12a9 9 0 0 1 15.3-6.4M21 12a9 9 0 0 1-15.3 6.4"/><path d="M3 3v5h5M21 21v-5h-5"/>',
    'download' => '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 19h16"/>',
    'dot' => '<circle cx="12" cy="12" r="5"/>',
    'play' => '<path d="M6 4l14 8-14 8V4z"/>',
    'search' => '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    'search-sm' => '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    'target' => '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.5"/>',
    'box' => '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    'layers' => '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
    'clock' => '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    'tag' => '<path d="M20 12 12.5 19.5a2 2 0 0 1-2.8 0l-6.2-6.2a2 2 0 0 1 0-2.8L11 3h9v9Z"/><circle cx="15" cy="8" r="1.5"/>',
    'chevron' => '<path d="m9 6 6 6-6 6"/>',
    'empty' => '<path d="M4 7h16l-1.5 12.5a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8L4 7Z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/>',
    'check' => '<path d="m5 12 5 5 9-10"/>',
    'alert' => '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
    'asc' => '<path d="m6 15 6-6 6 6"/>',
    'desc' => '<path d="m6 9 6 6 6-6"/>',
    'sort-none' => '<path d="m8 9 4-4 4 4M8 15l4 4 4-4" opacity="0.4"/>',
];

function sp_icon(string $name): string
{
    $body = SP_ICONS[$name] ?? SP_ICONS['dot'];
    return '<svg class="icon icon-' . e($name) . '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . $body . '</svg>';
}

function sp_positive_int($value, int $fallback): int
{
    if (is_string($value) && preg_match('/^\d+$/', $value) && (int) $value > 0) {
        return (int) $value;
    }
    return $fallback;
}

/** The page's filters from the query string. Brands arrive as brand[]=... */
function sp_parse_filters(array $query): array
{
    $raw = $query['brand'] ?? [];
    $raw = is_array($raw) ? $raw : [$raw];
    $brands = [];
    foreach ($raw as $value) {
        $cleaned = trim((string) $value);
        if ($cleaned !== '' && !in_array($cleaned, $brands, true)) {
            $brands[] = $cleaned;
        }
    }
    return [
        'search' => trim((string) ($query['q'] ?? '')),
        'brands' => $brands,
        'status' => trim((string) ($query['status'] ?? '')),
        'page' => sp_positive_int($query['page'] ?? null, 1),
        'per_page' => sp_positive_int($query['per_page'] ?? null, 100),
        'history_page' => sp_positive_int($query['hpage'] ?? null, 1),
        'history_per_page' => sp_positive_int($query['hper_page'] ?? null, SP_HISTORY_PER_PAGE_DEFAULT),
        'sort' => trim((string) ($query['sort'] ?? 'date')) ?: 'date',
        'sort_dir' => trim((string) ($query['dir'] ?? 'desc')) ?: 'desc',
    ];
}

/** Base query (no page) for sort/export links; pass overrides such as page. */
function sp_build_query(array $filters, array $overrides = []): array
{
    return array_merge([
        'q' => $filters['search'], 'brand' => $filters['brands'], 'status' => $filters['status'], 'per_page' => $filters['per_page'],
        'hper_page' => $filters['history_per_page'], 'hpage' => $filters['history_page'], 'sort' => $filters['sort'], 'dir' => $filters['sort_dir'],
    ], $overrides);
}

/** Like url_for: lists become brand[]=..., empty values are dropped, _anchor becomes a fragment. */
function sp_url(string $path, array $params = []): string
{
    $parts = [];
    $anchor = '';
    foreach ($params as $key => $value) {
        if ($key === '_anchor') {
            $anchor = $value ? '#' . $value : '';
            continue;
        }
        if ($value === null || $value === '' || $value === []) {
            continue;
        }
        if (is_array($value)) {
            foreach ($value as $item) {
                $parts[] = rawurlencode($key) . '[]=' . rawurlencode((string) $item);
            }
        } else {
            $parts[] = rawurlencode($key) . '=' . rawurlencode((string) $value);
        }
    }
    $base = $path === '' ? 'index.php' : $path;
    if (str_contains($base, '?')) {
        return $base . ($parts ? '&' . implode('&', $parts) : '') . $anchor;
    }
    return $base . ($parts ? '?' . implode('&', $parts) : '') . $anchor;
}

function sp_active_filters(array $filters): array
{
    $active = [];
    if ($filters['search'] !== '') {
        $active[] = ['label' => 'Search "' . $filters['search'] . '"', 'remove_url' => sp_url('', sp_build_query($filters, ['q' => '', 'page' => 1]))];
    }
    foreach ($filters['brands'] as $selected) {
        $rest = array_values(array_filter($filters['brands'], fn ($b) => $b !== $selected));
        $active[] = ['label' => $selected, 'remove_url' => sp_url('', sp_build_query($filters, ['brand' => $rest, 'page' => 1]))];
    }
    if ($filters['status'] === 'ok' || $filters['status'] === 'error') {
        $active[] = ['label' => $filters['status'] === 'ok' ? 'Available' : 'Error', 'remove_url' => sp_url('', sp_build_query($filters, ['status' => '', 'page' => 1]))];
    }
    return $active;
}

function sp_pager_links(array $pagination, array $query, string $pageParam, string $anchor): array
{
    $link = fn (int $page) => sp_url('', array_merge($query, [$pageParam => $page], $anchor ? ['_anchor' => $anchor] : []));
    $pages = [];
    $previous = null;
    foreach ($pagination['page_numbers'] as $number) {
        $pages[] = ['number' => $number, 'url' => $link($number), 'current' => $number === $pagination['page'], 'gap' => $previous !== null && $number !== $previous + 1];
        $previous = $number;
    }
    return [
        'first' => $link(1), 'prev' => $link($pagination['prev_page']), 'next' => $link($pagination['next_page']),
        'last' => $link($pagination['total_pages']), 'pages' => $pages,
    ];
}

function sp_sort_headers(array $filters): array
{
    $headers = [];
    foreach ([['brand', 'Brand'], ['model', 'Model'], ['part', 'Spare Part'], ['price', 'Latest Price'], ['date', 'Last Checked']] as [$key, $label]) {
        $active = $filters['sort'] === $key;
        $nextDir = $active && $filters['sort_dir'] === 'desc' ? 'asc' : 'desc';
        $headers[] = [
            'key' => $key, 'label' => $label, 'active' => $active,
            'url' => sp_url('', ['sort' => $key, 'dir' => $nextDir, 'q' => $filters['search'], 'brand' => $filters['brands'], 'status' => $filters['status'], 'per_page' => $filters['per_page'], 'page' => 1]),
            'icon' => $active ? ($filters['sort_dir'] === 'asc' ? 'asc' : 'desc') : 'sort-none',
        ];
    }
    return $headers;
}

/** Render php/page.php with the dashboard data and return the HTML. */
function sp_render_page(array $context): string
{
    extract($context, EXTR_SKIP);
    ob_start();
    try {
        include __DIR__ . '/page.php';
        return (string) ob_get_clean();
    } catch (Throwable $error) {
        ob_end_clean();
        throw $error;
    }
}
