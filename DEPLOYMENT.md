# Deploying WorldForge

Target: a fresh Ubuntu 22.04 or 24.04 VPS with a domain pointed at it.

Once this is done, shipping a change is one command:

```bash
./deploy/update.sh
```

## Where do I type these commands?

**On the server, not on your own computer.** Open your SSH client (Termius,
PuTTY, Windows Terminal — any of them), connect to the VPS, and paste the
commands into that terminal session. Every command in this guide runs there
unless a step explicitly says otherwise.

Nothing here runs on your development machine. You write code locally and
`git push`; the server pulls it in step "Ship a change".

### You need a VPS first

If you have not rented one yet, nothing below can run. Any provider works —
Hetzner, DigitalOcean, Vultr, Linode. Choose:

- **Ubuntu 24.04 LTS**
- **2 vCPU, 4 GB RAM** (enough for everything on one box)

The provider gives you an **IP address** and either a root password or the
chance to upload an SSH key. Add those as a new Host in your SSH client. When
connecting shows you a prompt like `root@ubuntu:~#`, start at step 1.

---

## 1. Point your domain at the server

Create an **A record** for your domain (or subdomain) pointing at the VPS's IPv4
address. Do this first — the TLS certificate in step 6 requires it to already
resolve.

If you use Cloudflare, set the record to **DNS only** (grey cloud) until step 6
succeeds. Certbot's HTTP challenge cannot reach the server through the proxy.

## 2. Create a deploy user

Running the game as root means a bug in the app is a bug with root.

```bash
ssh root@YOUR_SERVER_IP
adduser --disabled-password --gecos "" worldforge
usermod -aG sudo worldforge
rsync --archive --chown=worldforge:worldforge ~/.ssh /home/worldforge/
```

Then reconnect as that user: `ssh worldforge@YOUR_SERVER_IP`

## 3. Clone the repository

The repo is private, so the server needs read access. A **deploy key** is the
narrow option — it grants one repository, read-only, and does not carry your
whole account:

```bash
ssh-keygen -t ed25519 -C "worldforge-vps" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Add that output at **GitHub → your repo → Settings → Deploy keys → Add key**.
Leave "Allow write access" unchecked. Then:

```bash
git clone git@github.com:Donavanm3/worldforge.git ~/worldforge
```

## 4. Provision the machine

Installs Node 22, pnpm, PostgreSQL 16 + PostGIS, Redis, Nginx, PM2 and a
firewall, then creates the database:

```bash
cd ~/worldforge && sudo ./deploy/setup.sh
```

It prints a generated `DATABASE_URL` at the end. **Copy it now** — the password
is not stored anywhere else.

The script is safe to re-run; it skips anything already installed.

## 5. Configure the environment

```bash
cp .env.example .env && nano .env
```

| Variable                 | Value                                         |
| ------------------------ | --------------------------------------------- |
| `NODE_ENV`               | `production`                                  |
| `DATABASE_URL`           | from step 4                                   |
| `REDIS_URL`              | `redis://localhost:6379`                      |
| `PUBLIC_URL`             | `https://your-domain.com` — no trailing slash |
| `JWT_SECRET`             | run `openssl rand -base64 48`                 |
| `SESSION_SECRET`         | run it again; use a different value           |
| `PAYMENT_SECRET_KEY`     | Stripe secret key (`sk_live_…`)               |
| `PAYMENT_WEBHOOK_SECRET` | from step 7                                   |

`PUBLIC_URL` must match your real domain: it drives CORS and the Stripe
redirect URLs. Leave the payment keys blank for now if you are not selling
access yet — the game runs fine without them and only checkout returns 503.

Lock the file down, since it holds every secret you have:

```bash
chmod 600 .env
```

## 6. First build and launch

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm migrate
pnpm seed          # only once, on a brand new world
pm2 start ecosystem.config.cjs && pm2 save
pm2 startup        # prints one command to run with sudo — run it
```

`pm2 startup` is what makes the game come back after a reboot.

Then Nginx and TLS:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/worldforge
sudo sed -i 's/worldforge.example.com/YOUR-DOMAIN/g' /etc/nginx/sites-available/worldforge
sudo ln -sf /etc/nginx/sites-available/worldforge /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR-DOMAIN
```

Certbot installs the certificate and sets up automatic renewal. If you paused
Cloudflare's proxy in step 1, turn it back on now and set SSL mode to **Full
(strict)**.

Check it:

```bash
curl https://YOUR-DOMAIN/api/health
```

You want `{"status":"ok","database":"ok","redis":"ok",...}`.

## 7. Stripe webhooks

Access is granted by the webhook and nothing else, so this has to be right.

At **Stripe → Developers → Webhooks → Add endpoint**:

- URL: `https://YOUR-DOMAIN/api/payments/webhook`
- Events: `checkout.session.completed`, `payment_intent.payment_failed`,
  `charge.refunded`

Copy the **signing secret** (`whsec_…`) into `PAYMENT_WEBHOOK_SECRET` in `.env`,
then `pm2 reload ecosystem.config.cjs --update-env`.

Send a test event from the Stripe dashboard and confirm it returns 200.

## 8. Make yourself an admin

The first admin has to be promoted by hand — there is no bootstrap endpoint on
purpose, since one would be an obvious way in.

Register through the site, then:

```bash
psql "$(grep ^DATABASE_URL .env | cut -d= -f2-)" \
  -c "update users set role='admin', beta_access=true, access_source='admin' where username='YOUR_USERNAME'"
```

`/admin` is then reachable, where you can set the beta price, open or close
registration, and switch the game between beta and released.

## 9. Nightly backups

Install the schedule without opening an editor:

```bash
(crontab -l 2>/dev/null | grep -v deploy/backup.sh; echo "0 3 * * * /home/worldforge/worldforge/deploy/backup.sh >> /home/worldforge/backup.log 2>&1") | crontab -
```

Confirm it took:

```bash
crontab -l
```

Keeps the 14 most recent dumps in `~/worldforge/backups`.

**Test the restore before you need it.** A backup you have never restored is a
guess:

```bash
gunzip -c backups/worldforge-YYYYMMDD-HHMMSS.sql.gz | psql "$DATABASE_URL"
```

Copies off the box are worth having too — `scp` them somewhere, or the same
disk failure takes the game and its backups together.

---

## Everyday use

### Ship a change

```bash
cd ~/worldforge && ./deploy/update.sh
```

It pulls, installs, **builds before touching anything running**, migrates,
reloads with zero downtime, and polls `/api/health` until it passes. A compile
error stops the deploy while the old version is still serving.

It refuses to run on a dirty working tree — edit code locally and push, don't
patch the server.

### Roll back

```bash
./deploy/rollback.sh <commit-sha>
```

This does **not** reverse migrations. If the bad deploy changed the schema,
check the old code still works against it, or restore from a backup instead.

### Watch it

```bash
pm2 status              # both processes should be online
pm2 logs wf-api         # API logs
pm2 logs wf-tick        # economy tick
pm2 monit               # live CPU and memory
curl localhost:3001/api/health
```

The economy tick records every run in the `tick_runs` table, so a stalled
scheduler is visible in SQL rather than just quietly leaving the world frozen:

```sql
select kind, started_at, finished_at, error from tick_runs order by started_at desc limit 10;
```

### Rotate a secret

Edit `.env`, then:

```bash
pm2 reload ecosystem.config.cjs --update-env
```

Changing `JWT_SECRET` signs everyone out — existing access tokens stop
verifying. That is the correct behaviour if the key leaked.

---

## Sizing

Two vCPU and 4 GB of RAM comfortably runs everything on one box. The API is
started in cluster mode with two workers (`WF_API_INSTANCES` in the
environment changes that); the tick deliberately runs as a single process,
because two schedulers would accrue interest twice.

When one machine stops being enough, the split is already clean: `DATABASE_URL`
and `REDIS_URL` can point anywhere, and the frontend is static files Nginx or a
CDN can serve from anywhere.

## When something is wrong

**502 from Nginx** — the API is not running. `pm2 status`, then `pm2 logs wf-api`.

**Health check says `database: down`** — check `DATABASE_URL` in `.env` and that
`systemctl status postgresql` is active. A hosted database needs
`?sslmode=require` on the end of the URL.

**Everything returns 500** — usually Redis. `systemctl status redis-server`.
Rate limiting fails open by design, so the game keeps serving if Redis dies, but
sessions and limits degrade.

**Webhook returns 400** — the signing secret does not match. Confirm
`PAYMENT_WEBHOOK_SECRET` is the one for _this_ endpoint, and reload PM2 after
editing `.env`.

**A player paid but has no access** — check the delivery in Stripe, then:

```sql
select provider_event_id, event_type, processed_at, error from payment_events order by received_at desc limit 20;
```

The `error` column says why it was refused. Failing that, grant access from
`/admin`, which records `access_source = 'admin'`.

---

## Using Termius

Every command in this guide is ordinary SSH — Termius runs them unchanged. Three
of its features are worth setting up, because they turn deploying into a tap.

### Connect with a key, not a password

In **Keychain → New Key → Generate**, make an Ed25519 key. Copy the public half,
then on the server (while still using password auth):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "PASTE_YOUR_TERMIUS_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Attach the key to the host in Termius and reconnect. Once that works, turn
password login off — it is the single biggest thing you can do for the security
of this box:

```bash
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload ssh
```

Keep your existing session open until you have confirmed a fresh connection
works, or a typo locks you out.

### Snippets — this is the "easy update" part

Termius Snippets are saved commands you run against a host with one tap, from
desktop or phone. Create these under **Snippets → New Snippet**:

| Name       | Command                                 |
| ---------- | --------------------------------------- |
| Deploy     | `cd ~/worldforge && ./deploy/update.sh` |
| Status     | `pm2 status`                            |
| API logs   | `pm2 logs wf-api --lines 80`            |
| Tick logs  | `pm2 logs wf-tick --lines 40`           |
| Health     | `curl -s localhost:3001/api/health`     |
| Backup now | `cd ~/worldforge && ./deploy/backup.sh` |

One more worth saving, too long for the table above — it shows whether the
economy tick is actually running:

```bash
cd ~/worldforge && psql "$(grep ^DATABASE_URL .env | cut -d= -f2-)" -c "select kind, started_at, finished_at, error from tick_runs order by started_at desc limit 10"
```

After that, shipping a change is: push from your machine, open Termius, tap
**Deploy**. The script does the rest and tells you if the health check fails.

### SFTP for `.env` and backups

Editing `.env` in nano over a phone keyboard is miserable. Termius has a built-in
SFTP browser — open the host's file manager, navigate to
`/home/worldforge/worldforge/.env`, and edit it in a real text field.

The same browser is how you pull backups off the server. Do that periodically:
a disk failure that takes the game also takes any backups sitting beside it.

After editing `.env`, reload so the processes pick it up:

```bash
pm2 reload ecosystem.config.cjs --update-env
```

### Port forwarding for database access

To use a desktop SQL client against the server's Postgres without exposing it to
the internet, add a **Port Forwarding** rule in Termius:

- Type: **Local**
- Local port: `55432`
- Destination host: `localhost`
- Destination port: `5432`

Connect to `localhost:55432` from your SQL client. The traffic rides your SSH
session, so the firewall rule keeping Postgres on loopback stays intact — do not
open 5432 to the world to save yourself this step.

### One caution about deploying from a phone

`update.sh` runs a build, which takes a minute or two. If Termius drops the
connection mid-run, the script dies partway — possibly after migrating but
before reloading. It is safe to simply run **Deploy** again; the script is
idempotent. But on a flaky connection, prefer:

```bash
cd ~/worldforge && tmux new -As deploy './deploy/update.sh'
```

That keeps it running server-side even if your phone disconnects. Reattach with
`tmux attach -t deploy`. Install it once with `sudo apt-get install -y tmux`.
