const express = require('express');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();
app.use(cors());

// Health check
app.get('/', (req, res) => res.send('2DCraft PeerServer OK'));

const server = app.listen(process.env.PORT || 9000, () => {
  console.log('PeerServer running on port', process.env.PORT || 9000);
});

const peerServer = ExpressPeerServer(server, {
  path: '/myapp',
  proxied: true,           // QUAN TRỌNG khi chạy sau reverse proxy của Render
  allow_discovery: false,
  alive_timeout: 60000
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log('Client connected:', client.getId());
});
peerServer.on('disconnect', (client) => {
  console.log('Client disconnected:', client.getId());
});
