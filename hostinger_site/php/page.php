<?php
/** The dashboard page. A line-for-line port of templates/dashboard.html (Jinja) to PHP. */
declare(strict_types=1);
/** @var array $job, $stats, $pagination, $history_pagination, $latest, $history, $brands, $selected_brands, $per_page_options, $history_per_page_options, $suggestions, $active_filters, $sort_headers, $latest_links, $history_links, $urls */
/** @var string $search, $sort, $sort_dir, $selected_status, $data_source */
/** @var int $selected_per_page */
?>
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Spareprice Dashboard</title>
    <link rel="stylesheet" href="<?= e($urls['css']) ?>">
  </head>
  <body>
    <div id="topLoader" class="top-loader" aria-hidden="true"></div>

    <header class="topbar">
      <div class="brand-block">
        <p class="eyebrow">Spareprice</p>
        <h1>Spare Part Price Dashboard</h1>
      </div>
      <div class="header-actions">
        <button type="button" class="icon-btn" data-action="refresh" title="Refresh">
          <?= sp_icon('refresh') ?>
          <span>Refresh</span>
        </button>
        <details class="export-menu">
          <summary class="icon-btn" title="Export prices to Excel">
            <?= sp_icon('download') ?>
            <span>Export Excel</span>
            <?= sp_icon('chevron') ?>
          </summary>
          <div class="export-panel">
            <a class="export-option" href="<?= e($urls['export_all']) ?>">
              <strong>All models</strong>
              <span>Every tracked price, official and Cashify</span>
            </a>
            <a class="export-option" href="<?= e($urls['export_view']) ?>">
              <strong>Current view</strong>
              <span>Only what the filters below are showing</span>
            </a>
            <form class="export-model" method="get" action="<?= e($urls['export_base']) ?>">
              <input type="hidden" name="action" value="export.xlsx">
              <input type="hidden" name="scope" value="model">
              <label for="exportModel"><strong>Particular model</strong></label>
              <input id="exportModel" name="model" list="exportModelOptions" placeholder="Type a model, e.g. Galaxy Z Fold5" autocomplete="off" required>
              <datalist id="exportModelOptions" data-source="<?= e($urls['models_json']) ?>"></datalist>
              <button type="submit">Export this model</button>
            </form>
          </div>
        </details>
        <span class="mode-pill live" title="Data source: <?= e($data_source) ?>">
          <?= sp_icon('dot') ?>
          Hostinger (live)
          &middot; <?= str_starts_with($data_source, 'MySQL') ? 'MySQL' : 'SQLite file' ?>
        </span>
      </div>
    </header>

    <main>
      <section id="jobStatus" class="job-status <?= $job['running'] ? 'running' : '' ?>" data-running="<?= $job['running'] ? 'true' : 'false' ?>">
        <div class="job-status-text">
          <strong><?= e($job['message']) ?></strong>
          <span>
            <?php if ($job['running']): ?>
              Time: calculating... | Done: <?= (int) ($job['progress']['done'] ?? 0) ?> models | Rows saved: <?= (int) ($job['progress']['rows'] ?? 0) ?> | Errors: <?= (int) ($job['progress']['errors'] ?? 0) ?><?php if (!empty($job['progress']['current'])): ?> | Current: <?= e($job['progress']['current']) ?><?php endif; ?>
            <?php elseif (!empty($job['started_at'])): ?>
              Started <?= e(sp_local_date($job['started_at'])) ?>
            <?php else: ?>
              Check the configured devices, or pick a brand and model and press Scrape Selected.
            <?php endif; ?>
          </span>
        </div>
        <?php if ($job['running']): ?><div class="job-bar"><i></i></div><?php endif; ?>
      </section>

      <section class="scrape-toolbar">
        <form action="<?= e($urls['check_now']) ?>" method="post">
          <button data-job-button data-idle-label="Check All Prices" data-running-label="Checking..." data-start-label="Checking all configured devices..." id="checkAllButton" class="primary-action" type="submit" <?= $job['running'] ? 'disabled' : '' ?>>
            <?= sp_icon('play') ?> <?= $job['running'] && str_starts_with((string) $job['message'], 'Checking') ? 'Checking...' : 'Check All Prices' ?>
          </button>
        </form>
        <form action="<?= e($urls['discover_scope']) ?>" method="post" class="scope-form">
          <select name="scrape_brand" aria-label="Scrape brand">
            <option value="all">All brands</option>
            <option value="apple">Apple</option>
            <option value="samsung">Samsung</option>
            <option value="oppo">OPPO</option>
            <option value="realme">realme</option>
            <option value="oneplus">OnePlus</option>
            <option value="mi">Mi / Xiaomi</option>
            <option value="vivo">vivo</option>
            <option value="iqoo">iQOO</option>
            <option value="motorola">Motorola</option>
            <option value="cashify">Cashify</option>
          </select>
          <input name="scrape_model" placeholder="Model or Cashify brand, e.g. Nokia">
          <button data-job-button data-idle-label="Scrape Selected" data-running-label="Scraping..." data-start-label="Scraping selected brand/model prices..." type="submit" <?= $job['running'] ? 'disabled' : '' ?>>
            <?= sp_icon('target') ?> Scrape Selected
          </button>
        </form>
      </section>

      <section class="stats" aria-label="Dashboard summary">
        <article>
          <?= sp_icon('box') ?>
          <div>
            <strong><?= (int) $stats['tracked'] ?></strong>
            <span>Tracked spare parts</span>
          </div>
        </article>
        <article>
          <?= sp_icon('layers') ?>
          <div>
            <strong><?= (int) $stats['models'] ?></strong>
            <span>Models tracked across <?= (int) $stats['brands'] ?> brands</span>
          </div>
        </article>
        <article>
          <?= sp_icon('clock') ?>
          <div>
            <strong><?= (int) $stats['updated_today'] ?></strong>
            <span>Prices updated today</span>
          </div>
        </article>
        <article>
          <?= sp_icon('tag') ?>
          <div>
            <strong><?= $stats['average_value'] !== null ? e(sp_money($stats['average_value'], 'INR')) : '-' ?></strong>
            <span>Average spare part price</span>
          </div>
        </article>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Latest Prices</h2>
            <p>
              <?php if ($pagination['total']): ?>
                Showing <?= $pagination['start'] ?>-<?= $pagination['end'] ?> of <?= $pagination['total'] ?> spare parts
              <?php else: ?>
                0 current model and spare-part prices
              <?php endif; ?>
            </p>
          </div>
          <button type="button" class="ghost-btn" id="toggleGroupsButton" data-collapsed-label="Expand all models" data-expanded-label="Collapse all models" hidden>Expand all models</button>
        </div>

        <form class="filter-bar" method="get" action="<?= e($urls['index']) ?>" id="filterForm">
          <input type="hidden" name="sort" value="<?= e($sort) ?>">
          <input type="hidden" name="dir" value="<?= e($sort_dir) ?>">
          <input type="hidden" name="hper_page" value="<?= (int) $history_pagination['per_page'] ?>">
          <div class="filter-search">
            <?= sp_icon('search-sm') ?>
            <input name="q" value="<?= e($search) ?>" placeholder="Search model or spare part..." list="spareSuggestions" autocomplete="off">
            <datalist id="spareSuggestions">
              <?php foreach ($suggestions as $suggestion): ?>
                <option value="<?= e($suggestion) ?>"></option>
              <?php endforeach; ?>
            </datalist>
          </div>
          <details class="brand-select">
            <summary aria-label="Filter by brand">
              <?php if (!$selected_brands): ?>
                All brands
              <?php elseif (count($selected_brands) === 1): ?>
                <?= e($selected_brands[0]) ?>
              <?php else: ?>
                <?= count($selected_brands) ?> brands
              <?php endif; ?>
              <?= sp_icon('chevron') ?>
            </summary>
            <div class="brand-select-panel">
              <?php foreach ($brands as $brand): ?>
                <label>
                  <input type="checkbox" name="brand[]" value="<?= e($brand) ?>" <?= in_array($brand, $selected_brands, true) ? 'checked' : '' ?>>
                  <?= e($brand) ?>
                </label>
              <?php endforeach; ?>
            </div>
          </details>
          <select name="per_page" aria-label="Rows per page">
            <?php foreach ($per_page_options as $option): ?>
              <option value="<?= $option ?>" <?= $selected_per_page === $option ? 'selected' : '' ?>><?= $option ?> rows</option>
            <?php endforeach; ?>
          </select>
          <input type="hidden" name="page" value="1">
          <div class="filter-actions">
            <a class="ghost-btn" href="<?= e($urls['index']) ?>">Reset</a>
            <button type="submit">Apply Filters</button>
          </div>
        </form>

        <?php if ($active_filters): ?>
          <div class="filter-chips">
            <span class="filter-chips-label">Active filters:</span>
            <?php foreach ($active_filters as $filter): ?>
              <a class="chip" href="<?= e($filter['remove_url']) ?>"><?= e($filter['label']) ?> <span aria-hidden="true">&times;</span></a>
            <?php endforeach; ?>
          </div>
        <?php endif; ?>

        <div class="table-wrap">
          <table class="data-table" data-expandable>
            <thead>
              <tr>
                <th></th>
                <?php foreach ($sort_headers as $header): ?>
                  <th class="sortable">
                    <a class="sort-link <?= $header['active'] ? 'active' : '' ?>" href="<?= e($header['url']) ?>">
                      <?= e($header['label']) ?>
                      <span class="sort-icon"><?= sp_icon($header['icon']) ?></span>
                    </a>
                  </th>
                <?php endforeach; ?>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              <?php if (!$latest): ?>
                <tr class="empty-row">
                  <td colspan="7">
                    <div class="empty-state">
                      <?= sp_icon('empty') ?>
                      <strong>No spare parts found.</strong>
                      <span>Try changing your filters or search terms.</span>
                    </div>
                  </td>
                </tr>
              <?php endif; ?>
              <?php foreach ($latest as $item): $row = $item['row']; $grouped = $item['groupSize'] > 1; ?>
                <?php if ($item['groupStart'] && $grouped): ?>
                  <tr class="group-header" data-group="<?= e($item['groupId']) ?>" tabindex="0" role="button" aria-expanded="false">
                    <td class="expand-cell"><?= sp_icon('chevron') ?></td>
                    <td colspan="2"><span class="badge badge-brand"><?= e($row['brand']) ?></span> <strong class="group-model"><?= e($item['groupLabel']) ?></strong></td>
                    <td colspan="4" class="group-meta"><?= (int) $item['groupSize'] ?> parts<?php if ($item['groupSources'] > 1): ?> &middot; <span class="compare-flag"><?= (int) $item['groupSources'] ?> sources</span><?php endif; ?></td>
                  </tr>
                <?php endif; ?>
                <tr class="row-toggle <?= $grouped ? 'group-child' : '' ?>" data-group="<?= $grouped ? e($item['groupId']) : '' ?>" data-drawer-title="<?= e($row['brand']) ?> <?= e($row['model']) ?> &middot; <?= e($row['part']) ?>" <?= $grouped ? 'hidden' : '' ?> tabindex="0">
                  <td class="expand-cell"><?= sp_icon('chevron') ?></td>
                  <td data-label="Brand" class="<?= $grouped ? 'grouped-cell' : '' ?>"><span class="badge badge-brand"><?= e($row['brand']) ?></span></td>
                  <td data-label="Model" class="<?= $grouped ? 'grouped-cell' : '' ?>"><?= e($row['model']) ?></td>
                  <td data-label="Spare Part"><?= e($row['part']) ?></td>
                  <td data-label="Latest Price" class="price">
                    <?php if ($row['competitors']): ?>
                      <div class="price-stack">
                        <div class="price-line"><span class="src-tag"><?= e($row['source']) ?></span><?= e(sp_money($row['price_value'], $row['currency'])) ?></div>
                        <?php foreach ($row['competitors'] as $other): ?>
                          <div class="price-line price-other" title="<?= e($other['part']) ?> &middot; checked <?= e(sp_local_date($other['date'])) ?>"><span class="src-tag src-tag-alt"><?= e($other['source']) ?></span><?= e(sp_money($other['price_value'], $other['currency'])) ?></div>
                        <?php endforeach; ?>
                      </div>
                    <?php else: ?>
                      <?= e(sp_money($row['price_value'], $row['currency'])) ?>
                    <?php endif; ?>
                  </td>
                  <td data-label="Last Checked"><?= e(sp_local_date($row['date'])) ?></td>
                  <td data-label="Source"><a href="<?= e($row['url']) ?>" target="_blank" rel="noreferrer" onclick="event.stopPropagation()"><?= e($row['source']) ?>&nbsp;&#8599;</a></td>
                </tr>
                <template class="row-detail-template">
                  <div class="detail-grid">
                    <div><span>Latest price</span><strong><?= e(sp_money($row['price_value'], $row['currency'])) ?></strong></div>
                    <div><span>Source</span><strong><?= e($row['source']) ?></strong></div>
                    <div><span>Currency</span><strong><?= e($row['currency'] ?: '-') ?></strong></div>
                    <div><span>Recorded text</span><strong><?= e($row['price'] ?: '-') ?></strong></div>
                    <div><span>Last checked</span><strong><?= e(sp_local_date($row['date'])) ?></strong></div>
                    <div><span>Source URL</span><strong class="truncate"><a href="<?= e($row['url']) ?>" target="_blank" rel="noreferrer"><?= e($row['url']) ?></a></strong></div>
                  </div>
                  <?php if ($row['competitors']): ?>
                    <h4 class="detail-subheading">Other sources for <?= e($row['category']) ?></h4>
                    <div class="detail-grid">
                      <?php foreach ($row['competitors'] as $other): ?>
                        <div>
                          <span><?= e($other['source']) ?> &middot; <?= e($other['part']) ?></span>
                          <strong><?= e(sp_money($other['price_value'], $other['currency'])) ?></strong>
                          <small>Checked <?= e(sp_local_date($other['date'])) ?> &middot; <a href="<?= e($other['url']) ?>" target="_blank" rel="noreferrer">Open&nbsp;&#8599;</a></small>
                        </div>
                      <?php endforeach; ?>
                    </div>
                  <?php endif; ?>
                </template>
              <?php endforeach; ?>
            </tbody>
          </table>
        </div>

        <div class="table-footer">
          <span class="footer-summary">
            <?php if ($pagination['total']): ?>
              Showing <?= $pagination['start'] ?>-<?= $pagination['end'] ?> of <?= $pagination['total'] ?> spare parts
            <?php else: ?>
              Showing 0 of 0 spare parts
            <?php endif; ?>
          </span>
          <nav class="pagination" aria-label="Latest prices pages">
            <?php if ($pagination['has_prev']): ?>
              <a href="<?= e($latest_links['first']) ?>">First</a>
              <a href="<?= e($latest_links['prev']) ?>">Prev</a>
            <?php else: ?>
              <span class="disabled">First</span>
              <span class="disabled">Prev</span>
            <?php endif; ?>
            <?php foreach ($latest_links['pages'] as $item): ?>
              <?php if ($item['gap']): ?><span class="ellipsis">&hellip;</span><?php endif; ?>
              <?php if ($item['current']): ?>
                <strong class="current-page"><?= $item['number'] ?></strong>
              <?php else: ?>
                <a href="<?= e($item['url']) ?>"><?= $item['number'] ?></a>
              <?php endif; ?>
            <?php endforeach; ?>
            <?php if ($pagination['has_next']): ?>
              <a href="<?= e($latest_links['next']) ?>">Next</a>
              <a href="<?= e($latest_links['last']) ?>">Last</a>
            <?php else: ?>
              <span class="disabled">Next</span>
              <span class="disabled">Last</span>
            <?php endif; ?>
          </nav>
        </div>
      </section>

      <section class="panel" id="recent-checks">
        <div class="panel-heading">
          <h2>Recent Checks</h2>
          <p>
            <?php if ($history_pagination['total']): ?>
              Showing <?= $history_pagination['start'] ?>-<?= $history_pagination['end'] ?> of <?= $history_pagination['total'] ?> checks, including errors
            <?php else: ?>
              0 checks
            <?php endif; ?>
          </p>
        </div>

        <form class="filter-bar filter-bar-compact" method="get" action="<?= e($urls['index']) ?>#recent-checks">
          <input type="hidden" name="q" value="<?= e($search) ?>">
          <?php foreach ($selected_brands as $brand): ?>
            <input type="hidden" name="brand[]" value="<?= e($brand) ?>">
          <?php endforeach; ?>
          <input type="hidden" name="per_page" value="<?= (int) $selected_per_page ?>">
          <input type="hidden" name="page" value="<?= (int) $pagination['page'] ?>">
          <input type="hidden" name="sort" value="<?= e($sort) ?>">
          <input type="hidden" name="dir" value="<?= e($sort_dir) ?>">
          <select name="status" aria-label="Filter by status" onchange="this.form.submit()">
            <option value="" <?= !$selected_status ? 'selected' : '' ?>>All statuses</option>
            <option value="ok" <?= $selected_status === 'ok' ? 'selected' : '' ?>>Available (ok)</option>
            <option value="error" <?= $selected_status === 'error' ? 'selected' : '' ?>>Failed (error)</option>
          </select>
          <select name="hper_page" aria-label="Checks per page" onchange="this.form.submit()">
            <?php foreach ($history_per_page_options as $option): ?>
              <option value="<?= $option ?>" <?= $history_pagination['per_page'] === $option ? 'selected' : '' ?>><?= $option ?> rows</option>
            <?php endforeach; ?>
          </select>
        </form>

        <div class="table-wrap">
          <table class="data-table" data-expandable>
            <thead>
              <tr>
                <th></th>
                <th>Date</th>
                <th>Brand</th>
                <th>Model</th>
                <th>Part</th>
                <th>Recorded Text</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <?php if (!$history): ?>
                <tr class="empty-row">
                  <td colspan="7">
                    <div class="empty-state">
                      <?= sp_icon('empty') ?>
                      <strong>No checks recorded yet.</strong>
                      <span>Run a scrape to populate this list.</span>
                    </div>
                  </td>
                </tr>
              <?php endif; ?>
              <?php foreach ($history as $row): $ok = $row['status'] === 'ok'; ?>
                <tr class="row-toggle" data-drawer-title="<?= e($row['brand']) ?> <?= e($row['model']) ?> &middot; <?= e($row['part']) ?>" tabindex="0">
                  <td class="expand-cell"><?= sp_icon('chevron') ?></td>
                  <td data-label="Date"><?= e(sp_local_date($row['date'])) ?></td>
                  <td data-label="Brand"><span class="badge badge-brand"><?= e($row['brand']) ?></span></td>
                  <td data-label="Model"><?= e($row['model']) ?></td>
                  <td data-label="Part"><?= e($row['part']) ?></td>
                  <td data-label="Recorded Text"><?= e($row['price'] ?: ($row['error'] ?: '-')) ?></td>
                  <td data-label="Status">
                    <span class="badge badge-status-<?= e($row['status']) ?>">
                      <?= $ok ? sp_icon('check') : sp_icon('alert') ?>
                      <?= $ok ? 'Available' : 'Error' ?>
                    </span>
                  </td>
                </tr>
                <template class="row-detail-template">
                  <div class="detail-grid">
                    <div><span>Checked</span><strong><?= e(sp_local_date($row['date'])) ?></strong></div>
                    <div><span>Currency</span><strong><?= e($row['currency'] ?: '-') ?></strong></div>
                    <div><span>Status</span><strong><?= e($row['status']) ?></strong></div>
                    <div><span>Error</span><strong><?= e($row['error'] ?: '-') ?></strong></div>
                    <div><span>Source URL</span><strong class="truncate"><a href="<?= e($row['url']) ?>" target="_blank" rel="noreferrer"><?= e($row['url']) ?></a></strong></div>
                  </div>
                </template>
              <?php endforeach; ?>
            </tbody>
          </table>
        </div>

        <div class="table-footer">
          <span class="footer-summary">
            <?php if ($history_pagination['total']): ?>
              Showing <?= $history_pagination['start'] ?>-<?= $history_pagination['end'] ?> of <?= $history_pagination['total'] ?> checks
            <?php else: ?>
              Showing 0 of 0 checks
            <?php endif; ?>
          </span>
          <nav class="pagination" aria-label="Recent checks pages">
            <?php if ($history_pagination['has_prev']): ?>
              <a href="<?= e($history_links['first']) ?>">First</a>
              <a href="<?= e($history_links['prev']) ?>">Prev</a>
            <?php else: ?>
              <span class="disabled">First</span>
              <span class="disabled">Prev</span>
            <?php endif; ?>
            <?php foreach ($history_links['pages'] as $item): ?>
              <?php if ($item['gap']): ?><span class="ellipsis">&hellip;</span><?php endif; ?>
              <?php if ($item['current']): ?>
                <strong class="current-page"><?= $item['number'] ?></strong>
              <?php else: ?>
                <a href="<?= e($item['url']) ?>"><?= $item['number'] ?></a>
              <?php endif; ?>
            <?php endforeach; ?>
            <?php if ($history_pagination['has_next']): ?>
              <a href="<?= e($history_links['next']) ?>">Next</a>
              <a href="<?= e($history_links['last']) ?>">Last</a>
            <?php else: ?>
              <span class="disabled">Next</span>
              <span class="disabled">Last</span>
            <?php endif; ?>
          </nav>
        </div>
      </section>
    </main>

    <div id="drawerBackdrop" class="drawer-backdrop" hidden></div>
    <aside id="detailDrawer" class="drawer" hidden aria-hidden="true" role="dialog" aria-label="Row details">
      <div class="drawer-header">
        <h3 id="drawerTitle"></h3>
        <button type="button" class="drawer-close" id="drawerClose" aria-label="Close details"><span aria-hidden="true">&times;</span></button>
      </div>
      <div class="drawer-body" id="drawerBody"></div>
    </aside>

    <script id="spareprice-series" type="application/json">[]</script>
    <script src="<?= e($urls['js']) ?>"></script>
  </body>
</html>
