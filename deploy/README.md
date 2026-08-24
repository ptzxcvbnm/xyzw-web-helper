# SSH deployment

The production instance uses these paths:

- Backend: `/opt/xyzw-web-helper/server`
- Static frontend: `/var/www/xyzw-web-helper`
- SQLite data: `/var/lib/xyzw/xyzw.db`
- Environment: `/etc/xyzw/xyzw.env`
- Nginx site: `/etc/nginx/sites-available/xyzw`

The backend dynamically loads `src/utils/bonProtocol.js`. A deployment bundle must
therefore include both `server/` and `src/utils/bonProtocol.js`, and the server
layout must expose the backend dependencies at `/opt/xyzw-web-helper/node_modules`
(currently a symlink to `server/node_modules`).

Useful checks:

```sh
systemctl status xyzw nginx certbot-ip-renew.timer
curl -fsS https://8.133.185.144/api/health
journalctl -u xyzw -n 100 --no-pager
```

Public users submit registration requests. The account is created only after the
authenticated `admin` user approves it from the registration review page.

Initialize or reset the admin password without placing it in shell history:

```sh
cd /opt/xyzw-web-helper/server
read -rsp 'New admin password: ' ADMIN_PASSWORD
export ADMIN_PASSWORD DATA_DIR=/var/lib/xyzw
npm run set-admin-password
unset ADMIN_PASSWORD
```

The frontend is built locally with `pnpm build`. Static files are served from
`/var/www/xyzw-web-helper`, while Nginx proxies `/api/` and `/ws` to the backend
bound to `127.0.0.1:3001`.

Never commit `/etc/xyzw/xyzw.env`, SQLite files, game tokens, or certificate
private keys. `xyzw.env.example` contains placeholders only.
