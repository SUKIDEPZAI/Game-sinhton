# Dragon Hunter — Profession & Skill System v2

## Level
- Level tối đa: **100**.
- Mỗi 100 XP tăng 1 level; ở Lv.100 XP được giữ 0.
- Save version: **4** (tự migrate từ v1/v2/v3).

## 6 nghề × 5 skill
Mỗi nghề có đúng 5 skill. Skill 1 có ngay từ Lv.1. Skill 2/3/4/5 mở lần lượt ở Lv.10/20/30/40.

Skill 1 là kỹ năng khởi đầu và được nâng cấp mỗi 10 level: Lv.10, 20, 30, ... 100.

## Điều khiển
- PC: **Q / W / E / R / T**.
- Mobile: 5 nút skill cảm ứng.
- Mỗi skill có mana cost và cooldown.
- UI hiển thị khóa, mana, cooldown và rank của skill khởi đầu.

## Multiplayer
Client phát skill event; server whitelist index 0..4 và có rate guard 250ms. Gameplay damage/XP của skill vẫn chạy local PvE giống kiến trúc Wraith hiện tại; server event dùng để đồng bộ hành động/cosmetic và chống spam cơ bản.
