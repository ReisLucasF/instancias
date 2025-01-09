require("dotenv").config(); // Carrega variáveis de ambiente
const express = require("express");
const AWS = require("aws-sdk");
const cors = require("cors");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configurar cliente Lightsail
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const lightsail = new AWS.Lightsail();

// Endpoint para buscar instâncias
app.get("/instances", async (req, res) => {
  try {
    const response = await lightsail.getInstances().promise();
    const instances = response.instances.map((instance) => ({
      name: instance.name,
      state: instance.state.name,
      blueprint: instance.blueprintId,
      bundle: instance.bundleId,
      region: instance.location.regionName,
      publicIp: instance.publicIpAddress || "No IP assigned",
    }));
    res.json({ status: "success", data: instances });
  } catch (error) {
    console.error("Erro ao buscar instâncias:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
