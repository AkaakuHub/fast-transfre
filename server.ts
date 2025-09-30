import WebSocket, { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 3000 });
const rooms = new Map<string, {
  host: WebSocket;
  clients: WebSocket[];
  hostId: number;
}>();

interface MessageData {
  type: string;
  roomCode?: string;
  clientId?: number;
  [key: string]: any;
}

// 4桁OTP生成
function generateOTP(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// クライアント接続処理
wss.on('connection', (ws: WebSocket) => {
  console.log('クライアント接続');

  let roomCode: string | null = null;
  let isHost = false;

  // メッセージ処理
  ws.on('message', (message: WebSocket.Data) => {
    const data: MessageData = JSON.parse(message.toString());

    switch (data.type) {
      case 'create-room':
        roomCode = generateOTP();
        isHost = true;

        rooms.set(roomCode, {
          host: ws,
          clients: [],
          hostId: Date.now()
        });

        ws.send(JSON.stringify({
          type: 'room-created',
          roomCode: roomCode
        }));

        console.log(`ルーム作成: ${roomCode}`);
        break;

      case 'join-room':
        if (!data.roomCode) break;

        const room = rooms.get(data.roomCode);

        if (room && room.host.readyState === WebSocket.OPEN) {
          roomCode = data.roomCode;
          room.clients.push(ws);

          ws.send(JSON.stringify({
            type: 'room-joined',
            roomCode: data.roomCode
          }));

          room.host.send(JSON.stringify({
            type: 'client-joined',
            clientId: Date.now()
          }));

          console.log(`クライアント参加: ${data.roomCode}`);
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: '無効なルームコードです'
          }));
        }
        break;

      case 'offer':
      case 'answer':
      case 'ice-candidate':
        // シグナリングデータ転送
        if (roomCode) {
          const targetRoom = rooms.get(roomCode);
          if (targetRoom) {
            const targets = isHost ? targetRoom.clients : [targetRoom.host];
            targets.forEach(target => {
              if (target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify(data));
              }
            });
          }
        }
        break;
    }
  });

  // 切断処理
  ws.on('close', () => {
    console.log('クライアント切断');

    if (roomCode && isHost) {
      rooms.delete(roomCode);
      console.log(`ルーム削除: ${roomCode}`);
    }
  });
});

console.log(`シグナリングサーバー起動: ws://localhost:3000`);