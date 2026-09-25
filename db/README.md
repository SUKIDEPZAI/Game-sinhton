# DB Folder

## Setup

1. Tạo PostgreSQL trên Render
2. Copy `DATABASE_URL` (Internal Database URL)
3. Thêm vào Environment Variables của service

## Migration

**Tự động:** Server gọi `migrate()` khi start.

**Thủ công:**
```bash
node db/migrate.js

