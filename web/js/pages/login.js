import { call, setToken, setUsername, ApiError } from '../api.js';

export function render(root, navigate) {
  root.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <h1>Zabbix</h1>
        <form id="login-form">
          <label>Username<input name="username" type="text" autocomplete="username" autofocus></label>
          <label>Password<input name="password" type="password" autocomplete="current-password"></label>
          <button type="submit">Sign in</button>
          <p id="login-error" class="error" hidden></p>
        </form>
      </div>
    </div>
  `;

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.hidden = true;

    const fd = new FormData(e.target);
    try {
      const token = await call('user.login', {
        username: fd.get('username'),
        password: fd.get('password'),
      });
      setToken(token);
      setUsername(fd.get('username'));
      navigate('/problems');
    } catch (err) {
      errEl.textContent = err.message || 'Login failed';
      errEl.hidden = false;
    }
  });
}
