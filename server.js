const { PeerServer } = require('peer');

const port = process.env.PORT || 9000;

const peerServer = PeerServer({
  port: port,
  path: '/myapp', // Đường dẫn tùy chỉnh, ví dụ: your-app.onrender.com/myapp
  proxied: true,  // Quan trọng khi chạy sau proxy của Render
  allow_discovery: true
});

console.log(`PeerJS server đang chạy trên cổng ${port}`);
