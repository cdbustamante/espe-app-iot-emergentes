require('dotenv').config(); 
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mqtt = require("mqtt");
const mongoose = require("mongoose");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const MQTT_URL = process.env.MQTT_URL || "mqtt://broker.emqx.io:1883";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/grupo2";
const TOPIC_TEMP = process.env.TOPIC_TEMP || "grupo2/temperatura";
const TOPIC_LED = process.env.TOPIC_LED || "grupo2/led";
const TOPIC_CMDLED = process.env.TOPIC_CMDLED || "grupo2/cmd/led";

// ---------- MongoDB ----------
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log(" Mongo conectado"))
  .catch((err) => console.error("Mongo error:", err));

const ReadingSchema = new mongoose.Schema(
  { 
    ts: { type: Date, index: true, default: Date.now }, 
    temp: { type: Number, min: -50, max: 150 }, // Validación para LM35
    led: { type: Number, enum: [0, 1], default: 0 }
  },
  { versionKey: false }
);

// Índice para consultas rápidas por tiempo
ReadingSchema.index({ ts: -1 });
const Reading = mongoose.model("Reading", ReadingSchema);

// ---------- MQTT ----------
const mclient = mqtt.connect(MQTT_URL);
let thresholdC = 30;
let lastLedState = 0;
let lastTemperature = null;

mclient.on("connect", () => {
  console.log("MQTT conectado:", MQTT_URL);
  mclient.subscribe([TOPIC_TEMP, TOPIC_LED], (err) => {
    if (err) {
      console.error("Error al suscribir topics:", err);
    } else {
      console.log("Suscrito a topics:", [TOPIC_TEMP, TOPIC_LED]);
    }
  });
});

mclient.on("message", async (topic, message) => {
  try {
    const payload = message.toString().trim();
    const timestamp = new Date();
    
    console.log(`MQTT - Topic: ${topic}, Payload: ${payload}, Time: ${timestamp.toISOString()}`);
    
    if (topic === TOPIC_TEMP) {
      const temp = parseFloat(payload);
      
      // Validar temperatura del LM35 (-55°C a 150°C)
      if (!Number.isNaN(temp) && temp >= -55 && temp <= 150) {
        lastTemperature = temp;
        console.log(`Temperatura válida: ${temp}°C`);
        
        // 1) Emitir a todos los clientes conectados
        io.emit("temp", temp);

        // 2) Evaluar umbral y controlar LED
        const shouldLedBeOn = temp >= thresholdC ? 1 : 0;
        
        if (shouldLedBeOn !== lastLedState) {
          const command = shouldLedBeOn ? "ON" : "OFF";
          mclient.publish(TOPIC_CMDLED, command);
          lastLedState = shouldLedBeOn;
          io.emit("led", lastLedState);
          console.log(`LED ${command} - Temp: ${temp}°C, Umbral: ${thresholdC}°C`);
        }

        // 3) Guardar en MongoDB con timestamp preciso
        try {
          const reading = new Reading({
            ts: timestamp,
            temp: temp,
            led: lastLedState
          });
          await reading.save();
          console.log(`Guardado en DB: ${temp}°C, LED: ${lastLedState}`);
        } catch (dbError) {
          console.error("Error guardando en DB:", dbError.message);
        }
        
      } else {
        console.warn(`Temperatura inválida ignorada: ${payload}`);
      }
      
    } else if (topic === TOPIC_LED) {
      // Estado directo del LED desde el Arduino
      const ledValue = (payload === "1" || payload === "ON") ? 1 : 0;
      
      if (ledValue !== lastLedState) {
        lastLedState = ledValue;
        io.emit("led", lastLedState);
        console.log(`Estado LED actualizado desde Arduino: ${ledValue}`);
        
        // Guardar cambio de estado del LED
        try {
          await Reading.create({
            ts: timestamp,
            temp: lastTemperature, // Mantener última temperatura
            led: lastLedState
          });
        } catch (dbError) {
          console.error("Error guardando estado LED:", dbError.message);
        }
      }
    }
    
  } catch (error) {
    console.error("Error procesando mensaje MQTT:", error);
  }
});

mclient.on("error", (error) => {
  console.error("Error de conexión MQTT:", error);
});

mclient.on("reconnect", () => {
  console.log("Reconectando MQTT...");
});

// ---------- API para historial ----------
app.get("/api/history", async (req, res) => {
  try {
    const minutes = Math.min(parseInt(req.query.minutes || "120", 10), 1440); // Máximo 24 horas
    const since = new Date(Date.now() - minutes * 60 * 1000);
    
    console.log(`Consultando historial desde: ${since.toISOString()}`);
    
    const docs = await Reading.find({ 
      ts: { $gte: since }, 
      temp: { $exists: true, $ne: null }
    })
    .sort({ ts: 1 }) // Orden cronológico
    .select({ _id: 0, ts: 1, temp: 1, led: 1 })
    .lean()
    .limit(1000); // Límite de seguridad
    
    console.log(`Historial encontrado: ${docs.length} registros`);
    
    // Formatear timestamps para Chart.js
    const formattedDocs = docs.map(doc => ({
      ts: doc.ts.toISOString(),
      temp: parseFloat(doc.temp).toFixed(1),
      led: doc.led
    }));
    
    res.json(formattedDocs);
    
  } catch (error) {
    console.error("Error consultando historial:", error);
    res.status(500).json({ 
      error: "Error consultando historial",
      message: error.message 
    });
  }
});

// API para estadísticas (opcional)
app.get("/api/stats", async (req, res) => {
  try {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const stats = await Reading.aggregate([
      { $match: { ts: { $gte: last24h }, temp: { $exists: true } } },
      {
        $group: {
          _id: null,
          avgTemp: { $avg: "$temp" },
          minTemp: { $min: "$temp" },
          maxTemp: { $max: "$temp" },
          count: { $sum: 1 },
          ledOnCount: { $sum: { $cond: [{ $eq: ["$led", 1] }, 1, 0] } }
        }
      }
    ]);
    
    res.json(stats[0] || {});
  } catch (error) {
    res.status(500).json({ error: "Error calculando estadísticas" });
  }
});

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  
  // Enviar estado actual al nuevo cliente
  socket.emit("threshold", thresholdC);
  socket.emit("led", lastLedState);
  
  if (lastTemperature !== null) {
    socket.emit("temp", lastTemperature);
  }

  socket.on("set_threshold", (val) => {
    const newThreshold = parseFloat(val);
    if (!Number.isNaN(newThreshold) && newThreshold >= 0 && newThreshold <= 100) {
      const oldThreshold = thresholdC;
      thresholdC = newThreshold;
      
      // Emitir a todos los clientes
      io.emit("threshold", thresholdC);
      
      console.log(`Umbral actualizado: ${oldThreshold}°C → ${thresholdC}°C por ${socket.id}`);
      
      // Reevaluar LED con nueva temperatura si existe
      if (lastTemperature !== null) {
        const shouldLedBeOn = lastTemperature >= thresholdC ? 1 : 0;
        if (shouldLedBeOn !== lastLedState) {
          mclient.publish(TOPIC_CMDLED, shouldLedBeOn ? "ON" : "OFF");
          lastLedState = shouldLedBeOn;
          io.emit("led", lastLedState);
          console.log(` LED ajustado por nuevo umbral: ${shouldLedBeOn ? 'ON' : 'OFF'}`);
        }
      }
    } else {
      console.warn(`Umbral inválido recibido: ${val} de ${socket.id}`);
    }
  });

  socket.on("disconnect", () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static("public"));

// Ruta principal
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    mqtt: mclient.connected,
    mongodb: mongoose.connection.readyState === 1,
    threshold: thresholdC,
    lastTemp: lastTemperature,
    ledState: lastLedState
  });
});

// ---------- Iniciar servidor ----------
server.listen(PORT, () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`MQTT Broker: ${MQTT_URL}`);
  console.log(`MongoDB: ${MONGODB_URI.replace(/\/\/.*@/, '//***:***@')}`);
  console.log(`Umbral inicial: ${thresholdC}°C`);
});