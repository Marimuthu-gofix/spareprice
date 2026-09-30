<?php
/**
 * Router for PHP's built-in web server, for trying the Hostinger site on a PC:
 *
 *   php -d extension=zip -S 127.0.0.1:5005 -t hostinger_site hostinger_site/php/dev-server.php
 *
 * It does what .htaccess does on Hostinger: real files are served as they
 * are, /api/... goes to the price API, and the dashboard's path routes
 * (/job-status, /export.xlsx, ...) go to index.php?action=...
 * In the repository the API lives in ../hostinger_api; on the server it is
 * the api/ folder next to index.php. Not used on the server (the .htaccess
 * rules block this folder).
 */
declare(strict_types=1);

$root = dirname(__DIR__);
$api = is_file($root . '/api/index.php') ? $root . '/api' : dirname($root) . '/hostinger_api';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if ($path !== '/' && is_file($root . $path) && !preg_match('#^/php/#', $path)) {
    return false;
}
if (preg_match('#^/api(/|$)#', $path)) {
    $_SERVER['SCRIPT_NAME'] = '/api/index.php';
    require $api . '/index.php';
    return true;
}
if (preg_match('#^/(job-status|check-now|discover-all|discover-scope|models\.json|export\.csv|export\.xlsx)/?$#', $path, $m)) {
    $_GET['action'] = $m[1];
}
require $root . '/index.php';
