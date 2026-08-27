import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  html,
  /function homeSubscriptionLine\(j\)/,
  'Home screen subscription text should be built by a dedicated helper'
);

assert.match(
  html,
  /Subscription: '\+d\+' days remaining/,
  'The home screen should show the remaining subscription days in a clear "Subscription: X days remaining" line'
);

assert.match(
  html,
  /function paintHomeSubLines\(force\)[\s\S]*?homeSubscriptionLine\(j\)/,
  'paintHomeSubLines should render the dedicated subscription-days line under the clock'
);

assert.match(
  html,
  /\.home-sub-line\.home-sub-main\{[^}]*font-size:12px[^}]*font-weight:800/,
  'The main subscription-days line should be readable below the date/time text'
);
