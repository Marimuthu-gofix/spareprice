<?php
/**
 * Scrape buttons for the PHP dashboard. Shared hosting cannot run Chromium,
 * so "Check All Prices", "Scrape Selected" and the progress polling are
 * forwarded to the scraper host (the Render app), which writes its rows to
 * this site's /api. The last state seen is kept in php/cache/job.json so a
 * page load never has to wait for Render to wake up.
 */
declare(strict_types=1);

const SP_JOB_CACHE = SP_CACHE_DIR . '/job.json';

function sp_scraper_url(): string
{
    $config = sp_config();
    $url = (string) ($config['scraper_url'] ?? getenv('SCRAPER_URL') ?: 'https://spareprice.onrender.com');
    return rtrim(trim($url), '/');
}

function sp_default_job_state(string $message = 'Ready'): array
{
    return [
        'id' => null, 'running' => false, 'started_at' => null, 'finished_at' => null, 'returncode' => null,
        'message' => $message, 'output' => '', 'progress' => ['done' => 0, 'rows' => 0, 'errors' => 0, 'current' => '', 'scope' => ''],
    ];
}

/** Last job state seen from the scraper host, without asking it again. */
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
        @file_put_contents(SP_JOB_CACHE, json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }
}

/**
 * Forward a job request. Returns [http status, state array]. The scraper's
 * answer (or an error state) is remembered for the next page load.
 */
function sp_proxy_job(string $route, string $method, array $form = []): array
{
    $url = sp_scraper_url() . '/' . ltrim($route, '/');
    $timeout = $method === 'POST' ? 90 : 60; // the free Render app may need a minute to wake up
    @set_time_limit($timeout + 20);
    $body = null;
    $status = 0;
    $error = '';
    if (function_exists('curl_init')) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_CONNECTTIMEOUT => 15, CURLOPT_TIMEOUT => $timeout,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
        ]);
        if ($method === 'POST') {
            curl_setopt($curl, CURLOPT_POST, true);
            curl_setopt($curl, CURLOPT_POSTFIELDS, http_build_query($form));
        }
        $body = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = $body === false ? curl_error($curl) : '';
        curl_close($curl);
    } else {
        $context = stream_context_create(['http' => [
            'method' => $method, 'timeout' => $timeout, 'ignore_errors' => true,
            'header' => "Accept: application/json\r\n" . ($method === 'POST' ? "Content-Type: application/x-www-form-urlencoded\r\n" : ''),
            'content' => $method === 'POST' ? http_build_query($form) : '',
        ]]);
        $body = @file_get_contents($url, false, $context);
        foreach ($http_response_header ?? [] as $header) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $header, $m)) {
                $status = (int) $m[1];
            }
        }
        $error = $body === false ? 'request failed' : '';
    }
    $state = is_string($body) ? json_decode($body, true) : null;
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
