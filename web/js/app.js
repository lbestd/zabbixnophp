/**
 * App shell: hash-based router + nav.
 */
import { isLoggedIn, clearToken, getUsername, ApiError } from './api.js';
import { render as renderLogin }      from './pages/login.js';
import { render as renderDashboard }  from './pages/dashboard.js';
import { render as renderProblems }   from './pages/problems.js';
import { render as renderHosts }      from './pages/hosts.js';
import { render as renderHostDetail, renderItemDetail, renderTriggerDetail } from './pages/host-detail.js';
import { render as renderLatest }     from './pages/latest.js';
import { render as renderItem }          from './pages/item.js';
import { render as renderDiscoveryRule } from './pages/discovery-rule.js';
import { render as renderHostgroups }   from './pages/hostgroups.js';
import { render as renderMacros }       from './pages/macros.js';
import { render as renderEventDetail }  from './pages/event-detail.js';
import { render as renderTemplates }    from './pages/templates.js';
import { render as renderMaintenance }  from './pages/config-maintenance.js';
import { render as renderActions }      from './pages/config-actions.js';
import { render as renderUsers }        from './pages/admin-users.js';
import { render as renderUsergroups }   from './pages/admin-usergroups.js';
import { render as renderAuditlog }     from './pages/admin-auditlog.js';
import { render as renderProxies }      from './pages/admin-proxies.js';
import { render as renderConfigTriggers } from './pages/config-triggers.js';
import { render as renderConfigItems }    from './pages/config-items.js';

const root = document.getElementById('app');

// ── Router ────────────────────────────────────────────────────────────────────

const routes = [
  { re: /^\/login$/,                          fn: ()    => renderLogin(root, navigate) },
  { re: /^\/dashboard$/,                      fn: ()    => renderDashboard(root) },
  { re: /^\/problems$/,                       fn: ()    => renderProblems(root) },
  { re: /^\/hosts$/,                          fn: ()    => renderHosts(root) },
  { re: /^\/hosts\/(\d+)\/items\/(\d+)$/,    fn: (m) => renderItemDetail(root, m[1], m[2]) },
  { re: /^\/hosts\/(\d+)\/triggers\/(\d+)$/, fn: (m) => renderTriggerDetail(root, m[1], m[2]) },
  { re: /^\/hosts\/(\d+)\/(items|triggers|discovery|macros|edit)$/, fn: (m) => renderHostDetail(root, m[1], m[2]) },
  { re: /^\/hosts\/(\d+)\/discovery\/(\d+)\/(rule|items|triggers|graphs|filter)$/, fn: (m) => renderDiscoveryRule(root, m[1], m[2], m[3]) },
  { re: /^\/hosts\/(\d+)\/discovery\/(\d+)$/, fn: (m) => renderDiscoveryRule(root, m[1], m[2], 'rule') },
  { re: /^\/latest$/,                         fn: ()    => renderLatest(root) },
  { re: /^\/item$/,                           fn: ()    => renderItem(root) },
  { re: /^\/events\/(\d+)$/,                  fn: (m)   => renderEventDetail(root, m[1]) },
  { re: /^\/config\/hostgroups$/,             fn: ()    => renderHostgroups(root) },
  { re: /^\/config\/templates$/,             fn: ()    => renderTemplates(root) },
  { re: /^\/config\/maintenance$/,           fn: ()    => renderMaintenance(root) },
  { re: /^\/config\/actions$/,               fn: ()    => renderActions(root) },
  { re: /^\/config\/triggers$/,             fn: ()    => renderConfigTriggers(root) },
  { re: /^\/config\/items$/,               fn: ()    => renderConfigItems(root) },
  { re: /^\/admin\/proxies$/,               fn: ()    => renderProxies(root) },
  { re: /^\/admin\/users$/,                  fn: ()    => renderUsers(root) },
  { re: /^\/admin\/usergroups$/,             fn: ()    => renderUsergroups(root) },
  { re: /^\/admin\/auditlog$/,               fn: ()    => renderAuditlog(root) },
  { re: /^\/admin\/macros$/,                  fn: ()    => renderMacros(root) },
];

export function navigate(path) {
  location.hash = path;
}

function currentPath() {
  return location.hash.replace(/^#/, '').replace(/\?.*$/, '') || '/dashboard';
}

async function route() {
  const path = currentPath();

  if (!isLoggedIn() && path !== '/login') { navigate('/login'); return; }
  if (isLoggedIn() && path === '/login')  { navigate('/dashboard'); return; }

  const matched = routes.find(r => r.re.test(path));
  const m = matched ? path.match(matched.re) : null;

  renderShell(path);
  try {
    if (matched) await matched.fn(m);
    else content().innerHTML = '<p class="error">Page not found.</p>';
  } catch (e) {
    if (e instanceof ApiError && e.code === 200) {
      clearToken(); navigate('/login');
    } else {
      content().innerHTML = `<p class="error">Error: ${esc(e.message)}</p>`;
    }
  }
}

// ── Shell ─────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { section: 'Monitoring' },
  { label: 'Problems',    path: '/problems' },
  { label: 'Hosts',       path: '/hosts' },
  { label: 'Latest data', path: '/latest' },
  { section: 'Configuration' },
  { label: 'Host groups', path: '/config/hostgroups' },
  { label: 'Templates',   path: '/config/templates' },
  { label: 'Maintenance', path: '/config/maintenance' },
  { label: 'Actions',     path: '/config/actions' },
  { label: 'Triggers',    path: '/config/triggers' },
  { label: 'Items',       path: '/config/items' },
  { section: 'Administration' },
  { label: 'Users',       path: '/admin/users' },
  { label: 'User groups', path: '/admin/usergroups' },
  { label: 'Macros',      path: '/admin/macros' },
  { label: 'Proxies',     path: '/admin/proxies' },
  { label: 'Audit log',   path: '/admin/auditlog' },
];

function buildNavHtml() {
  let out = '';
  let inGroup = false;
  for (const item of NAV_ITEMS) {
    if (item.section) {
      if (inGroup) out += '</div>';
      out += `<div class="nav-group"><span class="nav-group-label">${item.section}</span>`;
      inGroup = true;
    } else if (item.todo) {
      out += `<span class="nav-item nav-todo">${item.label}</span>`;
    } else {
      out += `<a href="#${item.path}" class="nav-link" data-path="${item.path}">${item.label}</a>`;
    }
  }
  if (inGroup) out += '</div>';
  return out;
}

function updateActiveNav(activePath) {
  document.querySelectorAll('#zbx-nav a.nav-link[data-path]').forEach(a => {
    a.classList.toggle('nav-active', activePath.startsWith(a.dataset.path));
  });
}

function renderShell(activePath) {
  // Login page: no sidebar
  if (activePath === '/login') {
    const existingNav = document.getElementById('zbx-nav');
    if (existingNav) {
      existingNav.remove();
      const existingMain = document.getElementById('zbx-main');
      if (existingMain) existingMain.remove();
    }
    if (!document.getElementById('zbx-main')) {
      const main = document.createElement('main');
      main.id = 'zbx-main';
      root.appendChild(main);
    }
    return;
  }

  const existing = document.getElementById('zbx-nav');
  if (existing) {
    updateActiveNav(activePath);
    return;
  }

  root.innerHTML = '';
  const nav = document.createElement('nav');
  nav.id = 'zbx-nav';
  nav.innerHTML = `
    <div class="nav-brand">Zabbix</div>
    <div class="nav-sections">${buildNavHtml()}</div>
    <div class="nav-footer">
      <span class="nav-user-name">${esc(getUsername())}</span>
      <button id="nav-logout" class="nav-sign-out">Sign out</button>
    </div>
  `;
  const main = document.createElement('main');
  main.id = 'zbx-main';
  root.appendChild(nav);
  root.appendChild(main);

  updateActiveNav(activePath);
  document.getElementById('nav-logout').addEventListener('click', () => {
    clearToken(); navigate('/login');
  });
}

export function content() {
  return document.getElementById('zbx-main') || root;
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('hashchange', route);
route();
