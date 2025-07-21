const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const cors = require("cors")
const app = express()
const server = http.createServer(app)

// Enable CORS for all routes
app.use(cors())
app.use(express.json())

// Create Socket.IO server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST"]
  }
})

// Store rooms and their participants
const rooms = new Map()

// Express routes
app.get("/", (req, res) => {
  res.json({
    message: "Watch Party Socket.IO Server",
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
      participants: Array.from(room).map((socketId) => {
        const socket = io.sockets.sockets.get(socketId)
        return {
          userId: socket.userId,
          isHost: socket.isHost || false,
          connected: socket.connected,
        }
      }),
    })
  } else {
    res.status(404).json({ error: "Room not found" })
  }
})

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("New Socket.IO connection:", socket.id)

  // Send welcome message
  socket.emit("welcome", {
    message: "Connected to Watch Party Socket.IO Server",
    timestamp: new Date().toISOString(),
  })

  // Handle join room
  socket.on("join-room", (message) => {
    const { roomId, userId, isHost } = message
    console.log(`📨 Received join-room from ${userId} for room ${roomId}`)

    // Store user data on socket
    socket.userId = userId
    socket.roomId = roomId
    socket.isHost = isHost || false

    // Join Socket.IO room
    socket.join(roomId)

    // Get or create room in our tracking Map
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set())
      console.log(`🏠 Created new room: ${roomId}`)
    }
    const room = rooms.get(roomId)
    room.add(socket.id)

    console.log(`👋 User ${userId} joined room ${roomId} as ${isHost ? "host" : "viewer"}`)

    // Notify others in room about new participant
    socket.to(roomId).emit("user-joined", {
      from: userId,
      roomId: roomId,
      isHost: isHost,
    })

    // Get room size (number of clients)
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 1

    // Send current participant count to the new user
    socket.emit("participant-count", {
      count: roomSize,
      roomId: roomId,
    })

    // Broadcast updated participant count to all users in room
    io.to(roomId).emit("participant-count", {
      count: roomSize,
      roomId: roomId,
    })
  })

  // Handle host sharing
  socket.on("host-sharing", (message) => {
    if (!socket.roomId) return
    console.log(`📺 Host ${socket.userId} started sharing in room ${socket.roomId}`)
    
    // Add from field if not present
    message.from = socket.userId
    
    // Broadcast to all viewers in room
    socket.to(socket.roomId).emit("host-sharing", message)
  })

  // Handle host stopped
  socket.on("host-stopped", (message) => {
    if (!socket.roomId) return
    console.log(`🛑 Host ${socket.userId} stopped sharing in room ${socket.roomId}`)
    
    // Add from field if not present
    message.from = socket.userId
    
    // Broadcast to all viewers in room
    socket.to(socket.roomId).emit("host-stopped", message)
  })

  // Handle WebRTC signaling
  socket.on("offer", (message) => {
    if (!socket.roomId) return
    console.log(`📤 Forwarding offer from ${socket.userId} to ${message.to}`)
    
    // Add from field if not present
    message.from = socket.userId
    
    // Forward to specific user
    const targetSocket = findUserInRoom(socket.roomId, message.to)
    if (targetSocket) {
      io.to(targetSocket).emit("offer", message)
    } else {
      console.warn(`⚠️ Target user ${message.to} not found in room ${socket.roomId}`)
    }
  })

  socket.on("answer", (message) => {
    if (!socket.roomId) return
    console.log(`📤 Forwarding answer from ${socket.userId} to ${message.to}`)
    
    // Add from field if not present
    message.from = socket.userId
    
    // Forward to specific user
    const targetSocket = findUserInRoom(socket.roomId, message.to)
    if (targetSocket) {
      io.to(targetSocket).emit("answer", message)
    } else {
      console.warn(`⚠️ Target user ${message.to} not found in room ${socket.roomId}`)
    }
  })

  socket.on("ice-candidate", (message) => {
    if (!socket.roomId) return
    console.log(`🧊 Forwarding ICE candidate from ${socket.userId} to ${message.to}`)
    
    // Add from field if not present
    message.from = socket.userId
    
    // Forward to specific user
    const targetSocket = findUserInRoom(socket.roomId, message.to)
    if (targetSocket) {
      io.to(targetSocket).emit("ice-candidate", message)
    } else {
      console.warn(`⚠️ Target user ${message.to} not found in room ${socket.roomId}`)
    }
  })

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`🔌 Socket.IO connection closed: ${socket.id}`)
    
    if (socket.roomId && socket.userId) {
      const room = rooms.get(socket.roomId)
      if (room) {
        room.delete(socket.id)
        console.log(`👋 User ${socket.userId} left room ${socket.roomId}`)
        
        // Notify others about user leaving
        socket.to(socket.roomId).emit("user-left", {
          from: socket.userId,
          roomId: socket.roomId,
          isHost: socket.isHost,
        })
        
        // Get updated room size
        const roomSize = io.sockets.adapter.rooms.get(socket.roomId)?.size || 0
        
        // Broadcast updated participant count
        if (roomSize > 0) {
          io.to(socket.roomId).emit("participant-count", {
            count: roomSize,
            roomId: socket.roomId,
          })
        }
        
        // Clean up empty rooms
        if (room.size === 0) {
          rooms.delete(socket.roomId)
          console.log(`🗑️ Deleted empty room: ${socket.roomId}`)
        }
      }
    }
  })

  // Handle errors
  socket.on("error", (error) => {
    console.error("❌ Socket.IO error:", error)
  })
})

// Helper function to find a socket by userId in a room
function findUserInRoom(roomId, userId) {
  const room = rooms.get(roomId)
  if (room) {
    for (const socketId of room) {
      const socket = io.sockets.sockets.get(socketId)
      if (socket && socket.userId === userId) {
        return socketId
      }
    }
  }
  return null
}

// Start server
const PORT = process.env.PORT || 8080
server.listen(PORT, () => {
  console.log(`🚀 Watch Party Server running on port ${PORT}`)
  console.log(`📡 Socket.IO server ready`)
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
