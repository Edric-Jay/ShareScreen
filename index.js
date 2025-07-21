const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const cors = require("cors")

const app = express()
const server = http.createServer(app)

// Enable CORS for all routes
app.use(cors())
app.use(express.json())

// Create WebSocket server
const wss = new WebSocket.Server({ server })

// Store rooms and their participants
const rooms = new Map()

// Express routes
app.get("/", (req, res) => {
  res.json({
    message: "Watch Party WebSocket Server",
    status: "running",
    rooms: rooms.size,
    timestamp: new Date().toISOString(),
  })
})

app.get("/rooms", (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([roomId, participants]) => ({
    roomId,
    participantCount: participants.size,
  }))
  res.json({ rooms: roomList })
})

app.get("/rooms/:roomId", (req, res) => {
  const { roomId } = req.params
  const room = rooms.get(roomId)

  if (room) {
    res.json({
      roomId,
      participantCount: room.size,
      participants: Array.from(room).map((ws) => ({
        userId: ws.userId,
        isHost: ws.isHost || false,
        connected: ws.readyState === WebSocket.OPEN,
      })),
    })
  } else {
    res.status(404).json({ error: "Room not found" })
  }
})

// WebSocket connection handling
wss.on("connection", (ws, req) => {
  console.log("New WebSocket connection from:", req.socket.remoteAddress)

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString())
      const { type, roomId, from } = message

      console.log(`📨 Received ${type} from ${from} in room ${roomId}`)

      // Get or create room
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set())
        console.log(`🏠 Created new room: ${roomId}`)
      }
      const room = rooms.get(roomId)

      // Handle different message types
      switch (type) {
        case "join-room":
          room.add(ws)
          ws.roomId = roomId
          ws.userId = from
          ws.isHost = message.isHost || false

          console.log(`👋 User ${from} joined room ${roomId} as ${ws.isHost ? "host" : "viewer"}`)

          // Notify others in room about new participant
          broadcastToRoom(
            roomId,
            {
              type: "user-joined",
              from: from,
              roomId: roomId,
              isHost: ws.isHost,
            },
            ws,
          )

          // Send current participant count to the new user
          ws.send(
            JSON.stringify({
              type: "participant-count",
              count: room.size,
              roomId: roomId,
            }),
          )

          // Broadcast updated participant count to all users in room
          broadcastToRoom(roomId, {
            type: "participant-count",
            count: room.size,
            roomId: roomId,
          })
          break

        case "host-sharing":
          console.log(`📺 Host ${from} started sharing in room ${roomId}`)
          // Broadcast to all viewers in room
          broadcastToRoom(roomId, message, ws)
          break

        case "host-stopped":
          console.log(`🛑 Host ${from} stopped sharing in room ${roomId}`)
          // Broadcast to all viewers in room
          broadcastToRoom(roomId, message, ws)
          break

        case "offer":
          console.log(`📤 Forwarding offer from ${from} to ${message.to}`)
          // Send to specific user
          const targetWs = findUserInRoom(roomId, message.to)
          if (targetWs) {
            targetWs.send(JSON.stringify(message))
          } else {
            console.warn(`⚠️ Target user ${message.to} not found in room ${roomId}`)
          }
          break

        case "answer":
          console.log(`📤 Forwarding answer from ${from} to ${message.to}`)
          // Send to specific user
          const answerTargetWs = findUserInRoom(roomId, message.to)
          if (answerTargetWs) {
            answerTargetWs.send(JSON.stringify(message))
          } else {
            console.warn(`⚠️ Target user ${message.to} not found in room ${roomId}`)
          }
          break

        case "ice-candidate":
          console.log(`🧊 Forwarding ICE candidate from ${from} to ${message.to}`)
          // Send to specific user
          const iceTargetWs = findUserInRoom(roomId, message.to)
          if (iceTargetWs) {
            iceTargetWs.send(JSON.stringify(message))
          } else {
            console.warn(`⚠️ Target user ${message.to} not found in room ${roomId}`)
          }
          break

        default:
          console.warn(`❓ Unknown message type: ${type}`)
      }
    } catch (error) {
      console.error("❌ Error processing message:", error)
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to process message",
        }),
      )
    }
  })

  ws.on("close", () => {
    console.log("🔌 WebSocket connection closed")

    if (ws.roomId && ws.userId) {
      const room = rooms.get(ws.roomId)
      if (room) {
        room.delete(ws)
        console.log(`👋 User ${ws.userId} left room ${ws.roomId}`)

        // Notify others about user leaving
        broadcastToRoom(ws.roomId, {
          type: "user-left",
          from: ws.userId,
          roomId: ws.roomId,
          isHost: ws.isHost,
        })

        // Broadcast updated participant count
        if (room.size > 0) {
          broadcastToRoom(ws.roomId, {
            type: "participant-count",
            count: room.size,
            roomId: ws.roomId,
          })
        }

        // Clean up empty rooms
        if (room.size === 0) {
          rooms.delete(ws.roomId)
          console.log(`🗑️ Deleted empty room: ${ws.roomId}`)
        }
      }
    }
  })

  ws.on("error", (error) => {
    console.error("❌ WebSocket error:", error)
  })

  // Send welcome message
  ws.send(
    JSON.stringify({
      type: "welcome",
      message: "Connected to Watch Party WebSocket Server",
      timestamp: new Date().toISOString(),
    }),
  )
})

function broadcastToRoom(roomId, message, excludeWs = null) {
  const room = rooms.get(roomId)
  if (room) {
    let sentCount = 0
    room.forEach((ws) => {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message))
        sentCount++
      }
    })
    console.log(`📡 Broadcasted ${message.type} to ${sentCount} users in room ${roomId}`)
  }
}

function findUserInRoom(roomId, userId) {
  const room = rooms.get(roomId)
  if (room) {
    for (const ws of room) {
      if (ws.userId === userId && ws.readyState === WebSocket.OPEN) {
        return ws
      }
    }
  }
  return null
}

// Cleanup inactive connections every 30 seconds
setInterval(() => {
  let cleanedConnections = 0
  rooms.forEach((room, roomId) => {
    const activeConnections = new Set()
    room.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        activeConnections.add(ws)
      } else {
        cleanedConnections++
      }
    })

    if (activeConnections.size === 0) {
      rooms.delete(roomId)
      console.log(`🧹 Cleaned up empty room: ${roomId}`)
    } else if (activeConnections.size !== room.size) {
      rooms.set(roomId, activeConnections)
      console.log(`🧹 Cleaned ${room.size - activeConnections.size} inactive connections from room ${roomId}`)
    }
  })

  if (cleanedConnections > 0) {
    console.log(`🧹 Cleaned up ${cleanedConnections} inactive connections`)
  }
}, 30000)

const PORT = process.env.PORT || 8080
server.listen(PORT, () => {
  console.log(`🚀 Watch Party Server running on port ${PORT}`)
  console.log(`📡 WebSocket server ready`)
  console.log(`🌐 HTTP API available at http://localhost:${PORT}`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM, shutting down gracefully")
  server.close(() => {
    console.log("✅ Server closed")
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  console.log("🛑 Received SIGINT, shutting down gracefully")
  server.close(() => {
    console.log("✅ Server closed")
    process.exit(0)
  })
})
