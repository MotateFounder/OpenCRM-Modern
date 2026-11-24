<?php
// OpenCRM email tracker — single PHP file for your own web host (PHP 7.4+).
// Same behaviour as the Cloudflare Worker: it only stores random codes, times and the link/button used.
//
// Setup: OpenCRM → Settings → Email → Open & click tracking → "Save tracker.php…" (the secret is filled in),
// upload it to your site, e.g. https://yourdomain.com/t/tracker.php, then paste that address in OpenCRM.
// Events are kept in a data folder next to this file, protected by .htaccess (Apache) — or set $DATA_DIR
// to a folder outside the public web root.

$SECRET = '__OPENCRM_SECRET__';
$THANK_YOU = 'Thank you! Your answer has been received. We will be in touch soon.';
$DATA_DIR = __DIR__ . '/opencrm-data';

// ---------------------------------------------------------------------------------------------
header('X-Robots-Tag: noindex');
function no_store() { header('Cache-Control: no-store, no-cache, must-revalidate, private'); header('Pragma: no-cache'); header('Expires: 0'); }
function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function page($title, $body, $status = 200) {
  http_response_code($status); no_store(); header('Content-Type: text/html; charset=utf-8');
  echo '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' . h($title) . '</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f3f5f8;color:#1f2933;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}.c{background:#fff;padding:32px 36px;border-radius:12px;max-width:460px;box-shadow:0 2px 16px rgba(0,0,0,.08);text-align:center}h1{font-size:22px;margin:0 0 10px}p{line-height:1.5;color:#4b5563}button{font:inherit;background:#2f6fed;color:#fff;border:0;border-radius:8px;padding:10px 22px;cursor:pointer}</style></head><body><div class="c">' . $body . '</div></body></html>';
  exit;
}
function sig($msg) { global $SECRET; return substr(hash_hmac('sha256', $msg, $SECRET), 0, 24); }
function b64url_decode($s) { $b = strtr((string)$s, '-_', '+/'); return (string)base64_decode($b . str_repeat('=', (4 - strlen($b) % 4) % 4)); }
function valid_code($c) { return is_string($c) && preg_match('/^[A-Za-z0-9_-]{8,40}$/', $c); }
function json_out($data, $status = 200) { http_response_code($status); no_store(); header('Content-Type: application/json'); echo json_encode($data); exit; }

function data_file() {
  global $DATA_DIR;
  if (!is_dir($DATA_DIR)) { @mkdir($DATA_DIR, 0700, true); @file_put_contents($DATA_DIR . '/.htaccess', "Require all denied\nDeny from all\n"); @file_put_contents($DATA_DIR . '/index.html', ''); }
  return $DATA_DIR . '/events.jsonl';
}
function store_event($ev) {
  $f = data_file();
  $ev['id'] = sprintf('%.0f-%s', microtime(true) * 1000, bin2hex(random_bytes(4)));
  $fh = fopen($f, 'ab'); if (!$fh) return;
  flock($fh, LOCK_EX); fwrite($fh, json_encode($ev) . "\n"); fflush($fh); flock($fh, LOCK_UN); fclose($fh);
}
function list_events($limit) {
  $f = data_file(); $out = [];
  if (!file_exists($f)) return $out;
  $fh = fopen($f, 'rb'); flock($fh, LOCK_SH);
  while (($line = fgets($fh)) !== false && count($out) < $limit) { $e = json_decode($line, true); if ($e) $out[] = $e; }
  flock($fh, LOCK_UN); fclose($fh);
  return $out;
}
function ack_events($ids) {
  $f = data_file(); if (!file_exists($f)) return 0;
  $set = array_flip(array_map('strval', $ids)); $kept = []; $n = 0;
  $fh = fopen($f, 'c+b'); flock($fh, LOCK_EX);
  while (($line = fgets($fh)) !== false) { $e = json_decode($line, true); if ($e && isset($set[(string)$e['id']])) { $n++; continue; } if (trim($line) !== '') $kept[] = rtrim($line, "\n"); }
  ftruncate($fh, 0); rewind($fh); if ($kept) fwrite($fh, implode("\n", $kept) . "\n"); fflush($fh); flock($fh, LOCK_UN); fclose($fh);
  return $n;
}
function meta() { return ['ua' => substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 160), 'org' => '']; }

// route: tracker.php/o/<code>.gif   or   tracker.php?p=/o/<code>.gif (hosts without PATH_INFO)
$path = $_SERVER['PATH_INFO'] ?? ($_GET['p'] ?? '/');
$parts = array_values(array_filter(explode('/', $path), 'strlen'));
$now = (int)round(microtime(true) * 1000);
$a = $parts[0] ?? '';

if ($a === 'o' && isset($parts[1])) {
  $code = preg_replace('/\.gif$/', '', $parts[1]);
  if (valid_code($code)) store_event(['ts' => $now, 'type' => 'open', 'code' => $code] + meta());
  no_store(); header('Content-Type: image/gif'); echo base64_decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'); exit;
}
if ($a === 'c' && isset($parts[1], $parts[2])) {
  $code = $parts[1]; $n = (int)$parts[2]; $target = b64url_decode($_GET['u'] ?? ''); $s = $_GET['s'] ?? '';
  if (!valid_code($code) || !preg_match('#^https?://#i', $target) || !hash_equals(sig("c|$code|$n|$target"), (string)$s)) page('Link not valid', '<h1>This link is not valid</h1>', 400);
  store_event(['ts' => $now, 'type' => 'click', 'code' => $code, 'n' => $n, 'v' => substr($target, 0, 300)] + meta());
  no_store(); header('Location: ' . $target, true, 302); exit;
}
if ($a === 'i' && isset($parts[1], $parts[2])) {
  $code = $parts[1]; $choice = substr(urldecode($parts[2]), 0, 60); $r = isset($_GET['r']) ? b64url_decode($_GET['r']) : ''; $s = $_GET['s'] ?? '';
  if (!valid_code($code) || !hash_equals(sig("i|$code|$choice|$r"), (string)$s)) page('Link not valid', '<h1>This link is not valid</h1>', 400);
  store_event(['ts' => $now, 'type' => 'interest', 'code' => $code, 'v' => $choice] + meta());
  if (preg_match('#^https?://#i', $r)) { no_store(); header('Location: ' . $r, true, 302); exit; }
  page('Thank you', '<h1>&#10003; Thank you!</h1><p>' . h($THANK_YOU) . '</p>');
}
if ($a === 'u' && isset($parts[1])) {
  $code = $parts[1]; $s = $_GET['s'] ?? '';
  if (!valid_code($code) || !hash_equals(sig("u|$code"), (string)$s)) page('Link not valid', '<h1>This link is not valid</h1>', 400);
  if ($_SERVER['REQUEST_METHOD'] === 'POST') { store_event(['ts' => $now, 'type' => 'unsub', 'code' => $code] + meta()); page('Unsubscribed', '<h1>You have been unsubscribed</h1><p>You will not receive these emails any more.</p>'); }
  page('Unsubscribe', '<h1>Unsubscribe?</h1><p>Click the button to stop receiving these emails.</p><form method="post"><button type="submit">Unsubscribe</button></form>');
}
if ($a === 'api') {
  $auth = preg_replace('/^Bearer\s+/i', '', $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? ($_GET['key'] ?? '')));
  if ($SECRET === '__OPENCRM_SECRET__' || !hash_equals($SECRET, (string)$auth)) json_out(['error' => 'unauthorized'], 401);
  $b = $parts[1] ?? '';
  if ($b === 'health') json_out(['ok' => true, 'version' => 1, 'storage' => 'file']);
  if ($b === 'events') json_out(['events' => list_events(min(1000, (int)($_GET['limit'] ?? 500) ?: 500))]);
  if ($b === 'ack' && $_SERVER['REQUEST_METHOD'] === 'POST') { $body = json_decode(file_get_contents('php://input'), true); json_out(['deleted' => ack_events(is_array($body['ids'] ?? null) ? array_slice($body['ids'], 0, 1000) : [])]); }
  json_out(['error' => 'not found'], 404);
}
header('Content-Type: text/plain'); echo 'OK';
