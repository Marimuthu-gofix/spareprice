<?php
/**
 * Scrape buttons for the PHP dashboard. Shared hosting cannot run Chromium,
 * so "Check All Prices" and "Scrape Selected" are handed to a machine that
 * can, and this file reports the progress back to the page:
 *
 *   GitHub Actions  when api/config.php has 'github_token': the button starts
 *                   the repository's scrape workflow for that brand and
 *                   model, and the run's status is read from GitHub's API.
 *   Render app      otherwise: the request is forwarded to 'scraper_url'.
 *
 * Either way the scraper posts its rows to this site's /api. The last state
 * is kept in php/cache/job.json so a page load never waits on another host.
 */
declare(strict_types=1);

const SP_JOB_CACHE = SP_CACHE_DIR . '/job.json';
const SP_GITHUB_DEFAULT_REPO = 'Marimuthu-gofix/spareprice';

function sp_default_job_state(string $message = 'Ready'): array
{
    return [
        'id' => null, 'running' => false, 'started_at' => null, 'finished_at' => null, 'returncode' => null,
        'message' => $message, 'output' => '', 'progress' => ['done' => 0, 'rows' => 0, 'errors' => 0, 'current' => '', 'scope' => ''],
    ];
}

/** Last job state that was saved, without asking another host. */
function sp_job_state(): array
{
    if (is_file(SP_JOB_CACHE)) {
        $state = json_decode((string) file_get_contents(SP_JOB_CACHE), true);
        if (is_array($state) && array_key_exists('running', $state)) {
            return $state + sp_default_job_state();
        }
    }
    return sp_default_job_state();
}

function sp_remember_job_state(array $state): void
{
    if (is_dir(SP_CACHE_DIR) || @mkdir(SP_CACHE_DIR, 0755, true)) {
        @file_put_contents(SP_JOB_CACHE, json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
    }
}

/** What the browser gets: the job state without the internal GitHub bookkeeping. */
function sp_public_job_state(array $state): array
{
    unset($state['github']);
    return $state;
}

/** One HTTP request. Returns [status code, body or null, error text]. */
function sp_http(string $method, string $url, array $headers = [], ?string $body = null, int $timeout = 30): array
{
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_CONNECTTIMEOUT => 15, CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers,
        ]);
        if ($body !== null) {
            curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
        }
        $response = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = $response === false ? curl_error($curl) : '';
        curl_close($curl);
        return [$status, $response === false ? null : (string) $response, $error];
    }
    $context = stream_context_create(['http' => [
        'method' => $method, 'timeout' => $timeout, 'ignore_errors' => true,
        'header' => implode("\r\n", $headers) . "\r\n", 'content' => $body ?? '',
    ]]);
    $response = @file_get_contents($url, false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $header) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $header, $m)) {
            $status = (int) $m[1];
        }
    }
    return [$status, $response === false ? null : $response, $response === false ? 'request failed' : ''];
}

// ------------------------------------------------------------- Render app
function sp_scraper_url(): string
{
    $config = sp_config();
    $url = (string) ($config['scraper_url'] ?? getenv('SCRAPER_URL') ?: 'https://spareprice.onrender.com');
    return rtrim(trim($url), '/');
}

/**
 * Forward a job request to the Render app. Returns [http status, state].
 * The scraper's answer (or an error state) is remembered for the next page load.
 */
function sp_proxy_job(string $route, string $method, array $form = []): array
{
    $timeout = $method === 'POST' ? 90 : 60; // the free Render app may need a minute to wake up
    @set_time_limit($timeout + 20);
    $headers = ['Accept: application/json'];
    $body = null;
    if ($method === 'POST') {
        $headers[] = 'Content-Type: application/x-www-form-urlencoded';
        $body = http_build_query($form);
    }
    [$status, $response, $error] = sp_http($method, sp_scraper_url() . '/' . ltrim($route, '/'), $headers, $body, $timeout);
    $state = is_string($response) ? json_decode($response, true) : null;
    if (!is_array($state) || !array_key_exists('running', $state)) {
        $state = sp_job_state();
        $state['running'] = false;
        $state['message'] = 'Scraper host is not reachable (' . sp_scraper_url() . ')';
        $state['output'] = $error ?: ('HTTP ' . $status);
        sp_remember_job_state($state);
        return [502, $state];
    }
    sp_remember_job_state($state);
    return [$status ?: 200, $state];
}

// --------------------------------------------------------- GitHub Actions
/** GitHub settings from api/config.php, or null when no token is configured. */
function sp_github_config(): ?array
{
    $config = sp_config();
    $token = trim((string) ($config['github_token'] ?? ''));
    if ($token === '') {
        return null;
    }
    return [
        'token' => $token,
        'repo' => trim((string) ($config['github_repo'] ?? SP_GITHUB_DEFAULT_REPO), " /"),
        'workflow' => trim((string) ($config['github_workflow'] ?? 'scrape.yml')),
        'ref' => trim((string) ($config['github_ref'] ?? 'main')),
        'api' => rtrim(trim((string) ($config['github_api'] ?? 'https://api.github.com')), '/'),
        'poll_seconds' => max(1, (int) ($config['github_poll_seconds'] ?? 8)),
    ];
}

/** One GitHub API call for the repository. Returns [status, decoded JSON or null, error text]. */
function sp_github_api(array $github, string $method, string $path, ?array $body = null): array
{
    $headers = [
        'Accept: application/vnd.github+json',
        'Authorization: Bearer ' . $github['token'],
        'X-GitHub-Api-Version: 2022-11-28',
        'User-Agent: spareprice-dashboard',
    ];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
    }
    [$status, $response, $error] = sp_http(
        $method, $github['api'] . '/repos/' . $github['repo'] . $path, $headers, $body === null ? null : json_encode($body), 25,
    );
    $json = is_string($response) && $response !== '' ? json_decode($response, true) : null;
    if ($error === '' && $status >= 400) {
        $error = is_array($json) && isset($json['message']) ? (string) $json['message'] : 'HTTP ' . $status;
    }
    return [$status, is_array($json) ? $json : null, $error];
}

function sp_store_row_count(): int
{
    try {
        return sp_status(sp_db())['count'];
    } catch (Throwable) {
        return 0;
    }
}

/** Start the scrape workflow on GitHub. Returns [http status, state]. */
function sp_start_github_job(array $github, string $brand, string $model): array
{
    $current = sp_job_state();
    $startedAt = (int) ($current['github']['dispatched_at'] ?? 0);
    if (!empty($current['running']) && time() - $startedAt < 6 * 3600) {
        return [409, $current]; // one scrape at a time
    }

    $model = mb_substr($model, 0, 100);
    $scope = $brand === 'all' ? 'all brands' : $brand;
    if ($model !== '') {
        $scope .= ' matching ' . $model;
    }
    [$status, , $error] = sp_github_api(
        $github, 'POST', '/actions/workflows/' . rawurlencode($github['workflow']) . '/dispatches',
        ['ref' => $github['ref'], 'inputs' => ['brand' => $brand, 'model' => $model]],
    );
    if ($status !== 204 && $status !== 200) {
        $state = sp_default_job_state('GitHub did not accept the scrape request');
        $state['output'] = $error ?: ('HTTP ' . $status);
        $state['started_at'] = $state['finished_at'] = gmdate('c');
        $state['returncode'] = 1;
        $state['progress']['errors'] = 1;
        $state['progress']['scope'] = $scope;
        sp_remember_job_state($state);
        return [502, $state];
    }

    $message = "Scraping $scope on GitHub...";
    $state = sp_default_job_state($message);
    $state['id'] = bin2hex(random_bytes(8));
    $state['running'] = true;
    $state['started_at'] = gmdate('c');
    $state['progress']['scope'] = $message;
    $state['progress']['current'] = 'Waiting for GitHub to start the run';
    $state['github'] = [
        'dispatched_at' => time(), 'checked_at' => 0, 'run_id' => null, 'html_url' => null, 'rows_at_start' => sp_store_row_count(),
    ];
    sp_remember_job_state($state);
    return [202, $state];
}

/**
 * Bring the saved job state up to date from GitHub. Asks GitHub at most once
 * every few seconds however often the page polls. Returns [http status, state].
 */
function sp_refresh_github_job(array $github): array
{
    $state = sp_job_state();
    if (empty($state['running']) || empty($state['github'])) {
        return [200, $state];
    }
    $job = $state['github'];
    if (time() - (int) $job['checked_at'] < $github['poll_seconds']) {
        return [200, $state];
    }
    $job['checked_at'] = time();
    $finish = function (int $code, string $message, string $finishedAt = '') use (&$state): void {
        $state['running'] = false;
        $state['returncode'] = $code;
        $state['message'] = $message;
        $state['finished_at'] = $finishedAt !== '' ? $finishedAt : gmdate('c');
        $state['progress']['current'] = '';
        if ($code !== 0) {
            $state['progress']['errors'] = max(1, (int) $state['progress']['errors']);
        }
    };

    // The dispatch call does not say which run it created, so find the first
    // manually started run that appeared after the request.
    if (empty($job['run_id'])) {
        [$status, $json, $error] = sp_github_api(
            $github, 'GET', '/actions/workflows/' . rawurlencode($github['workflow']) . '/runs?event=workflow_dispatch&per_page=10',
        );
        if ($status === 200 && is_array($json)) {
            $best = null;
            foreach ($json['workflow_runs'] ?? [] as $run) {
                $created = strtotime((string) ($run['created_at'] ?? '')) ?: 0;
                if ($created >= (int) $job['dispatched_at'] - 20 && ($best === null || $created < $best['created'])) {
                    $best = ['created' => $created, 'run' => $run];
                }
            }
            if ($best !== null) {
                $job['run_id'] = $best['run']['id'];
                $job['html_url'] = $best['run']['html_url'] ?? null;
                $state['output'] = (string) ($job['html_url'] ?? '');
            }
        } elseif ($status === 401 || $status === 403 || $status === 404) {
            $state['output'] = $error;
            $finish(1, 'GitHub refused the request; check github_token and github_repo');
        }
        if (empty($job['run_id']) && $state['running'] && time() - (int) $job['dispatched_at'] > 240) {
            $finish(1, 'GitHub did not start the scrape run');
        }
    }

    if (!empty($job['run_id']) && $state['running']) {
        [$status, $run] = sp_github_api($github, 'GET', '/actions/runs/' . $job['run_id']);
        if ($status === 200 && is_array($run)) {
            if (($run['status'] ?? '') === 'completed') {
                $conclusion = (string) ($run['conclusion'] ?? 'unknown');
                $finish(
                    $conclusion === 'success' ? 0 : 1,
                    $conclusion === 'success' ? 'Scrape finished on GitHub' : "Scrape on GitHub ended: $conclusion",
                    (string) ($run['updated_at'] ?? ''),
                );
            } else {
                $step = ($run['status'] ?? '') === 'in_progress' ? 'Starting' : 'Queued on GitHub';
                [$jobsStatus, $jobs] = sp_github_api($github, 'GET', '/actions/runs/' . $job['run_id'] . '/jobs');
                if ($jobsStatus === 200 && is_array($jobs)) {
                    foreach ($jobs['jobs'][0]['steps'] ?? [] as $candidate) {
                        if (($candidate['status'] ?? '') === 'in_progress') {
                            $step = (string) $candidate['name'];
                        }
                    }
                }
                $state['progress']['current'] = 'GitHub: ' . $step;
            }
        }
    }

    if (time() - (int) $job['dispatched_at'] > 6 * 3600 && $state['running']) {
        $finish(1, 'Lost track of the scrape run on GitHub');
    }
    $state['progress']['rows'] = max(0, sp_store_row_count() - (int) $job['rows_at_start']);
    $state['github'] = $job;
    sp_remember_job_state($state);
    return [200, $state];
}
