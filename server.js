require("dotenv").config(); // Carrega variáveis de ambiente
const express = require("express");
const AWS = require("aws-sdk");
const cors = require("cors");
const crypto = require('crypto');
const { exec } = require('child_process');

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

app.get("/instances", async (req, res) => {
  try {
    // Obter instâncias
    const response = await lightsail.getInstances().promise();

    // Obter domínios associados
    const domainResponse = await lightsail.getDomains().promise();
    const domains = domainResponse.domains;

    const instances = await Promise.all(
      response.instances.map(async (instance) => {
        // Buscar métricas da instância (CPU, rede, etc.)
        const [cpuUsage] = await Promise.all([
          lightsail.getInstanceMetricData({
            instanceName: instance.name,
            metricName: "CPUUtilization",
            period: 60,
            startTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            endTime: new Date().toISOString(),
            statistics: ["Average"],
            unit: "Percent",
          }).promise(),
        ]);

        // Encontrar domínio associado
        const associatedDomain = domains
          .flatMap((domain) => domain.domainEntries)
          .find((entry) => entry.target === instance.publicIpAddress);

        return {
          name: instance.name,
          state: instance.state.name,
          blueprint: instance.blueprintId,
          bundle: instance.bundleId,
          region: instance.location.regionName,
          publicIp: instance.publicIpAddress || "No IP assigned",
          dns: associatedDomain ? associatedDomain.name : "No domain assigned",
          metrics: {
            cpu: cpuUsage.metricData.length ? cpuUsage.metricData[0].average : "No data",
          },
        };
      })
    );

    res.json({ status: "success", data: instances });
  } catch (error) {
    console.error("Erro ao buscar instâncias ou domínios:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});




// Webhook para atualizar o servidor
app.post('/webhook', express.json(), (req, res) => {
  const secret = 'minha-chave-secreta'; // Substitua pela chave configurada no GitHub
  const payload = JSON.stringify(req.body);

  if (!req.headers['x-hub-signature-256']) {
    console.error('Signature missing.');
    return res.status(403).send('Signature missing.');
  }

  const signature = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;

  if (req.headers['x-hub-signature-256'] !== signature) {
    console.error('Invalid signature.');
    return res.status(403).send('Invalid signature.');
  }

  console.log('Webhook recebido:', req.body);

  if (req.body.ref === 'refs/heads/main') { // Verifica se é um push na branch "main"
    exec('cd /opt/bitnami/projects/instancias && git pull && pm2 restart instancias', (err, stdout, stderr) => {
      if (err) {
        console.error(`Erro ao atualizar o servidor: ${stderr}`);
        return res.status(500).send('Erro ao atualizar o servidor.');
      }
      console.log(`Servidor atualizado: ${stdout}`);
      res.status(200).send('Servidor atualizado.');
    });
  } else {
    res.status(200).send('Nenhuma ação necessária.');
  }
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
