<?php
// TEMPLATE ONLY. Copy this file to config.php (same folder) and put your
// real values in config.php, never here. config.php is ignored by git on
// purpose: it holds the database password and the API key, and those must
// never be uploaded to GitHub.
return [
    // From hPanel > Databases > Management. Hostinger's host is usually
    // "localhost"; the database and user names start with "u" and digits.
    'dsn' => 'mysql:host=localhost;dbname=u123456789_spareprice;charset=utf8mb4',
    'user' => 'u123456789_spareprice',
    'password' => 'change-me',

    // Long random secret. The same value goes into PRICE_API_KEY on Render,
    // in the GitHub Actions secret, and in the .env file on your PC.
    // Generate one with:  python -c "import secrets; print(secrets.token_urlsafe(32))"
    'api_key' => 'change-me',
];
