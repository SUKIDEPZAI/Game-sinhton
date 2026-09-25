# Dragon Hunter — Báo cáo rà soát và bản vá V1.1

Nguồn: `prompt_fullsource_2026-09-25T14-57-13.txt` (25/09/2026). Gói này trích xuất **16 file văn bản**; 13 file PNG chỉ có tên/hash trong prompt, **không có dữ liệu ảnh**, vì vậy không thể tái tạo ảnh gốc. Chép nguyên thư mục `assets/` từ dự án hiện tại trước khi chạy.

## Những lỗi đã xử lý

1. **HP và hồi sinh tùy ý:** `server.js` trước đây chấp nhận mọi `msg.hp` từ `move`; nay HP giao tranh do server quản lý, chỉ nhận hồi sinh từ 0 lên HP tối đa sau ít nhất 800 ms kể từ lúc server xác nhận tử trận, tương thích `DEATH_RESPAWN_DELAY=0.8` của client.
2. **Di chuyển thiếu kiểm tra đầu vào:** chặn NaN/Infinity/toạ độ ngoài map, chặn di chuyển khi đã chết và kiểm tra tốc độ ngay cả khi khoảng cách thời gian bất thường; vẫn duy trì dung sai mạng của dự án.
3. **Tạo phòng trùng mã:** thử lại khi mã 6 ký tự đang tồn tại; dùng `crypto.randomInt` thay cho `Math.random`.
4. **WebSocket thiếu giới hạn dữ liệu:** giới hạn mỗi tin nhắn 16 KiB, kiểm tra cấu trúc tin nhắn trước khi xử lý.
5. **Sai lệch snapshot delta:** lấy nội dung tái dựng khi phiên bản liền trước là delta; chỉ lưu delta nếu kiểm chứng tái dựng đúng và có lợi về dung lượng. Với bản lớn, lưu full snapshot để tránh diff quá tốn CPU/bộ nhớ.
6. **Xoá snapshot gốc làm hỏng phiên bản phụ thuộc:** từ chối xoá riêng một version đang có delta phụ thuộc (HTTP 409), cả Prompt API lẫn Admin API.
7. **Quyền truy cập prompt:** kiểm tra chủ sở hữu project/version trước khi xem, so sánh, ghi hoặc xoá; dự án dùng slug toàn cục như schema cũ nên các tài khoản khác không thể cùng sở hữu slug đó.
8. **Đọc file quản trị:** tăng cường kiểm tra đường dẫn tương đối và đường dẫn thật (`realpath`) để chặn traversal/symlink thoát root.
9. **Khởi động khi migration lỗi:** không tiếp tục dùng DB chưa được migrate thành công.
10. **CORS:** mặc định không cấp quyền cross-origin; đặt `CORS_ORIGINS=https://domain1,https://domain2` nếu frontend được host khác origin.
11. **Phòng không hoạt động:** không dọn phòng chỉ vì không có hoạt động trong khi người chơi vẫn kết nối.

## Hạn chế và việc nên làm tiếp

- **PvP chưa hoàn toàn server-authoritative:** client vẫn gửi sát thương (`dmg`); bản vá giới hạn 1–7 (theo nhóm vũ khí hiện có), nhưng chưa xác thực vũ khí, inventory, hitbox và cooldown theo loại vũ khí. Cần chuyển inventory/equipment đáng tin cậy lên server và thiết kế giao thức mới trước khi triển khai PvP cạnh tranh.
- **Dữ liệu save vẫn do client gửi:** server giới hạn kích thước nhưng chưa xác minh vật phẩm, XP, level. Không coi dữ liệu này là chống gian lận.
- **Snapshot lịch sử cũ:** phiên bản delta đã hỏng trước khi vá không thể tự phục hồi nếu mất full base; cần backup PostgreSQL trước khi nâng cấp.
- **Schema `prompt_projects.slug` unique toàn cục:** không hỗ trợ nhiều người dùng cùng slug `dragon-hunter`. Cần migration có chủ đích để đổi sang unique `(owner_id, slug)` nếu muốn multi-tenant.
- **Bản vá chưa kiểm thử tích hợp với PostgreSQL, browser hay các ảnh PNG thực tế** vì prompt không chứa DB và dữ liệu ảnh. Cần kiểm thử staging trước khi triển khai production.
- `README.md` cũ rất ngắn, cần cập nhật tài liệu vận hành đầy đủ. Gói này giữ nguyên file đó và cung cấp báo cáo riêng.

## Kiểm thử thực hiện

`node tests/smoke.test.js`: kiểm tra cú pháp 4 file JS backend, parse 3 JSON và 308 lượt kiểm tra round-trip thuật toán diff/delta. Không thay thế integration tests.

## Cài đặt

1. Sao lưu source, `.env` và PostgreSQL trước khi cập nhật.
2. Giải nén gói, chép nguyên thư mục `assets/` gồm 13 PNG từ source thật vào thư mục gốc (prompt không chứa binary ảnh).
3. Chạy `npm install` trong thư mục dự án. Cấu hình `DATABASE_URL`, `ADMIN_PASS`, `ADMIN_SECRET`, `CORS_ORIGINS` nếu cần.
4. Chạy `npm test` hoặc `node tests/smoke.test.js`, rồi `npm start`. Thử đăng nhập, tạo/join phòng, PvP, hồi sinh, tạo và xoá snapshot trên môi trường staging.
5. Không copy đè thư mục `assets/` bằng dữ liệu không rõ nguồn: metadata PNG đặc thù của game có thể bị mất.
