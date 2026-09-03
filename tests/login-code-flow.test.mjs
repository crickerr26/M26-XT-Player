import assert from 'node:assert/strict';
import fs from 'node:fs';

const licensing = fs.readFileSync(new URL('../licensing.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');

assert.match(
  licensing,
  /function normalizeLoginCode\(raw\)[\s\S]*?digits\.length === 6/,
  'The license store should normalize a customer-facing 6-digit login code'
);

assert.match(
  licensing,
  /freshLoginCode\(\)[\s\S]*?randomDigits6[\s\S]*?findByLoginCode/,
  'The license store should allocate a unique 6-digit login code'
);

assert.match(
  licensing,
  /if \(path === '\/api\/activate'\)[\s\S]*?const loginCode = normalizeLoginCode\(body\.code\)[\s\S]*?findByLoginCode\(loginCode\)/,
  'Customer activation should accept the 6-digit login code, not only the hidden 8-digit activation code'
);

assert.match(
  licensing,
  /path === '\/api\/admin\/activate'[\s\S]*?lic\.loginCode = lic\.loginCode \|\| this\.freshLoginCode\(\)[\s\S]*?loginCode: lic\.loginCode/,
  'Admin activation should return the short login code to give the customer'
);

assert.match(
  admin,
  /<b>Login Code<\/b>[\s\S]*?function showShareCode\(code\)[\s\S]*?a_newcode/,
  'The admin success panel should label the customer-facing value as Login Code'
);

assert.match(
  admin,
  /showShareCode\(r\.j\.loginCode\|\|r\.j\.code\)/,
  'Admin activation should show the 6-digit login code when the server returns one'
);

assert.match(
  html,
  /label for="actCodeBox">Login Code<\/label>/,
  'The customer login card should ask for the 6-digit Login Code'
);

assert.match(
  html,
  /id="actLoginBtn"[\s\S]*?>Login<\/button>/,
  'The customer login card should have an explicit Login button for the short code'
);

assert.match(
  html,
  /function loginCodeFmt\(c\)[\s\S]*?slice\(0,6\)/,
  'The customer code input should format the 6-digit Login Code'
);

assert.match(
  html,
  /if\(!\/\^\(\\d\{6\}\|\\d\{8\}\)\$\/\.test\(v\)\)[\s\S]*?A Login Code is 6 digits/,
  'The customer code commit should accept either the new 6-digit code or legacy 8-digit activation code'
);
