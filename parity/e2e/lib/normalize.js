#!/usr/bin/env node
// contracts/_meta.yaml normalize rules (kept in sync by hand — SSoT is the yaml).
'use strict';
function normalize(text, sandboxRoot) {
  let t = String(text);
  if (sandboxRoot) t = t.split(sandboxRoot).join('<ROOT>');
  t = t.replace(/(\/private)?\/var\/folders\/[^\s"')]+/g, '<TMP>');
  t = t.replace(/(\/private)?\/tmp\/ecc-parity[^\s"')]*/g, '<TMP>');
  t = t.replace(/ses_[a-zA-Z0-9]+/g, '<SESSION_ID>');
  t = t.replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '<SESSION_ID>');
  t = t.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+(Z|[+-][0-9:]+)?/g, '<TIMESTAMP>');
  t = t.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}/g, '<DATE>');
  t = t.replace(/\b[0-9]{2}:[0-9]{2}(:[0-9]{2})?\b/g, '<TIME>');
  return t;
}
module.exports = { normalize };
