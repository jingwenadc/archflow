# 香港单机部署

这套部署面向首批 10–20 名内部用户：一台香港 Linux 服务器运行 Nginx、Next.js 和 FastAPI。Nginx 是唯一公网入口；Web 与 API 不发布宿主机端口。项目资料、案例、SQLite 和备份都位于宿主机 `/data`。

## 本地验收

```bash
cp .env.production.example .env.production
```

将 `.env.production` 中的 `BIND_ADDRESS` 改为 `127.0.0.1`、`HTTP_PORT` 改为 `8080`，`ARCHFLOW_DATA_DIR` 改为 `./.local/deployment-data`，`ARCHFLOW_BACKUP_DIR` 改为 `./.local/deployment-backups`，域名改为 `localhost`，来源改为 `http://localhost:8080`。然后生成本地测试密码并启动：

```bash
./scripts/set-basic-auth.sh
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d --wait
./scripts/smoke-test.sh
./scripts/backup.sh
docker compose --env-file .env.production down
```

## 服务器准备

推荐 Ubuntu 24.04 LTS、2 vCPU、4 GB 内存、至少 80 GB 云盘。只开放 SSH、80 和 443；SSH 使用密钥并限制来源 IP。安装 Docker Engine 与 Compose 插件后：

```bash
sudo install -d -m 0750 /opt/archflow /data/archflow /data/archflow-backups /data/letsencrypt/www /data/letsencrypt/config
sudo chown -R "$USER":"$USER" /opt/archflow /data/archflow /data/archflow-backups /data/letsencrypt
```

将仓库检出到 `/opt/archflow`，复制 `.env.production.example` 为 `.env.production`，填写真实域名、GitHub 集成和数据路径；公网部署保持 `BIND_ADDRESS=0.0.0.0`、`HTTP_PORT=80`、`HTTPS_PORT=443`。`.env.production` 权限设为 `0600`。

## 共享密码

明文密码不写入 `.env.production`、Git 或部署命令。运行：

```bash
./scripts/set-basic-auth.sh
```

脚本要求至少 16 位密码，并使用 bcrypt 生成权限为 `0600` 的 `deploy/nginx/.htpasswd`；该文件已被 Git 忽略。容器启动时只把它复制到 Nginx 的内存文件系统，并改为仅 Nginx 工作进程可读。HTTPS 启用前不要向用户分发密码，因为 HTTP Basic Auth 在纯 HTTP 下不能保护传输中的凭据。

## DNS 与 HTTPS

1. 将域名的 `A` 记录指向服务器公网 IPv4。
2. 暂时用基础 Compose 在公网 80 端口启动，以响应 ACME challenge。
3. 先设置 `LETSENCRYPT_STAGING=1` 验证流程（测试证书保存在独立的 `staging/` 目录），再改为 `0` 申请正式证书。

```bash
docker compose --env-file .env.production up -d --wait
./scripts/issue-certificate.sh
docker compose --env-file .env.production -f compose.yaml -f compose.https.yaml up -d --wait
```

正式 HTTPS 验证通过后运行 `./scripts/smoke-test.sh`，其中 `ARCHFLOW_BASE_URL` 应为 `https://你的域名`。建议用 root cron 每天执行 `renew-certificate.sh`，并每晚执行 `backup.sh`。

## 备份与恢复原则

`backup.sh` 先用 SQLite Online Backup API 创建一致数据库快照，再短暂暂停 API 容器打包文件，最后生成 SHA-256 校验文件并按保留天数清理旧备份。备份默认在 `/data/archflow-backups`；同一块云盘不是灾难恢复，正式上线后还必须将备份同步到另一个区域的对象存储并启用生命周期策略。

恢复前先停止 Compose，在备份目录内运行 `sha256sum -c 对应的.sha256`，解压到空的数据目录，并把归档中的 `.backup-db.sqlite3` 重命名为 `archflow.sqlite3`。不要覆盖仍在运行的数据库。

## 更新

```bash
git pull --ff-only
docker compose --env-file .env.production -f compose.yaml -f compose.https.yaml build
docker compose --env-file .env.production -f compose.yaml -f compose.https.yaml up -d --wait
```

更新完成后检查 `docker compose ps`、`/healthz`、受保护首页、API 和最近一次备份。任何涉及数据库结构的版本都应先备份再更新。
