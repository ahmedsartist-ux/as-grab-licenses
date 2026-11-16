// AS Grab licence admin: edits licenses.json in the public allow-list repo
// through the GitHub contents API. The token stays in this browser only.
// Writes are compare-and-swap on the file's sha, so two open tabs can't
// overwrite each other.
'use strict';

const REPO = 'ahmedsartist-ux/as-grab-licenses';
const FILE = 'licenses.json';
const API = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
const TOKEN_KEY = 'asgrab.admin.token';
const NOTES_KEY = 'asgrab.admin.notes';
const CODE_RE = /^[0-9A-F]{16}$/;

let current = { sha: null, data: { licenses: [] } };

const $ = (id) => document.getElementById(id);

function readStore(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    setStatus('المتصفح مش سامح بالحفظ. افتح الصفحة من غير وضع التصفح الخفي.');
  }
}

function notes() {
  try {
    return JSON.parse(readStore(NOTES_KEY, '{}')) || {};
  } catch {
    return {};
  }
}

function setStatus(text) {
  $('status').textContent = text;
}

function normalize(code) {
  return String(code).replace(/[^0-9a-z]/gi, '').toUpperCase();
}

function group(code) {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function parse(text) {
  const obj = JSON.parse(text);
  if (!obj || !Array.isArray(obj.licenses)) throw new Error('الملف مش قايمة تفعيل');
  const byCode = new Map();
  for (const entry of obj.licenses) {
    if (!entry || !CODE_RE.test(String(entry.h || '').toUpperCase())) continue;
    const clean = { h: String(entry.h).toUpperCase(), s: entry.s === 'active' ? 'active' : 'revoked' };
    if (typeof entry.exp === 'string' && /^\d{4}-\d{2}-\d{2}/.test(entry.exp)) clean.exp = entry.exp.slice(0, 10);
    byCode.set(clean.h, clean);
  }
  return { licenses: [...byCode.values()] };
}

async function api(method, body) {
  const token = readStore(TOKEN_KEY, '');
  if (!token) throw new Error('حط المفتاح الأول');
  const response = await fetch(API, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  return response;
}

async function load() {
  const response = await api('GET');
  if (response.status === 404) {
    current = { sha: null, data: { licenses: [] } };
    return;
  }
  if (response.status === 401 || response.status === 403) throw new Error('المفتاح مرفوض أو مالوش صلاحية');
  if (!response.ok) throw new Error(`GitHub رجّع ${response.status}`);
  const json = await response.json();
  current = { sha: json.sha, data: parse(fromBase64(json.content || '')) };
}

async function save(message, change) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await load();
    const next = change(structuredClone(current.data));
    const body = { message, content: toBase64(JSON.stringify(next, null, 2) + '\n') };
    if (current.sha) body.sha = current.sha;
    const response = await api('PUT', body);
    if (response.ok) {
      const json = await response.json();
      current = { sha: json.content.sha, data: next };
      return;
    }
    if (response.status !== 409 && response.status !== 422) throw new Error(`الحفظ فشل (${response.status})`);
  }
  throw new Error('الملف اتغيّر من مكان تاني. جرّب تاني');
}

function render() {
  const body = $('list');
  body.replaceChildren();
  const memo = notes();
  const list = [...current.data.licenses].sort((a, b) => (a.s === b.s ? 0 : a.s === 'active' ? -1 : 1));
  if (!list.length) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.className = 'muted';
    cell.textContent = 'مفيش أجهزة لسه.';
    return;
  }
  for (const entry of list) {
    const row = body.insertRow();
    const code = row.insertCell();
    code.className = 'code';
    code.textContent = group(entry.h);
    const state = row.insertCell();
    const pill = document.createElement('span');
    pill.className = `pill ${entry.s}`;
    pill.textContent = entry.s === 'active' ? 'مفعّل' : 'متوقف';
    state.append(pill);
    row.insertCell().textContent = entry.exp || '—';
    row.insertCell().textContent = memo[entry.h] || '';
    const actions = row.insertCell();
    const toggle = document.createElement('button');
    toggle.className = entry.s === 'active' ? 'bad' : 'ghost';
    toggle.textContent = entry.s === 'active' ? 'اقفل' : 'فعّل تاني';
    toggle.addEventListener('click', () => run(() => setState(entry.h, entry.s === 'active' ? 'revoked' : 'active', entry.exp)));
    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = 'امسح';
    remove.addEventListener('click', () => {
      if (confirm(`تمسح ${group(entry.h)} من القايمة؟ الجهاز هيتقفل.`)) run(() => removeCode(entry.h));
    });
    actions.append(toggle, ' ', remove);
  }
}

async function setState(code, state, exp) {
  await save(`${state === 'active' ? 'Activate' : 'Revoke'} ${code}`, (data) => {
    data.licenses = data.licenses.filter((entry) => entry.h !== code);
    const entry = { h: code, s: state };
    if (exp) entry.exp = exp;
    data.licenses.push(entry);
    return data;
  });
  setStatus(state === 'active' ? `اتفعّل ${group(code)}` : `اتقفل ${group(code)}`);
}

async function removeCode(code) {
  await save(`Remove ${code}`, (data) => {
    data.licenses = data.licenses.filter((entry) => entry.h !== code);
    return data;
  });
  setStatus(`اتمسح ${group(code)}`);
}

async function run(task) {
  try {
    setStatus('ثانية…');
    await task();
    render();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

$('saveToken').addEventListener('click', () => {
  const value = $('token').value.trim();
  if (!value) return setStatus('اكتب المفتاح');
  writeStore(TOKEN_KEY, value);
  $('token').value = '';
  run(load);
});

$('forget').addEventListener('click', () => {
  writeStore(TOKEN_KEY, null);
  current = { sha: null, data: { licenses: [] } };
  render();
  setStatus('اتنسى المفتاح من المتصفح ده');
});

$('activate').addEventListener('click', () => {
  const code = normalize($('code').value);
  if (!CODE_RE.test(code)) return setStatus('كود الجهاز لازم يبقى 16 حرف/رقم (A-F و 0-9)');
  const exp = $('exp').value || undefined;
  const note = $('note').value.trim();
  if (note) {
    const memo = notes();
    memo[code] = note.slice(0, 80);
    writeStore(NOTES_KEY, JSON.stringify(memo));
  }
  $('code').value = '';
  $('note').value = '';
  run(() => setState(code, 'active', exp));
});

$('reload').addEventListener('click', () => run(load));

if (readStore(TOKEN_KEY, '')) run(load);
