require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { exec } = require("child_process");
const { LightsailClient, GetInstancesCommand, GetDomainsCommand, GetInstanceMetricDataCommand } = require("@aws-sdk/client-lightsail");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuração do cliente Lightsail
const lightsailClient = new LightsailClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Lista de métricas a coletar
const METRICS = [
    { name: "CPUUtilization", unit: "Percent", period: 300 },
    { name: "NetworkIn", unit: "Bytes", period: 300 },
    { name: "NetworkOut", unit: "Bytes", period: 300 },
    { name: "StatusCheckFailed", unit: "Count", period: 60 },
    { name: "StatusCheckFailed_Instance", unit: "Count", period: 60 },
    { name: "StatusCheckFailed_System", unit: "Count", period: 60 },
    { name: "BurstCapacityTime", unit: "Seconds", period: 300 },
    { name: "BurstCapacityPercentage", unit: "Percent", period: 300 },
    { name: "MetadataNoToken", unit: "Count", period: 300 },
];

// Função auxiliar para realizar tentativas com repetição
async function fetchWithRetry(fetchFunction, retries = 3, delay = 1000) {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await fetchFunction();
        } catch (error) {
            lastError = error;
            console.error(`Erro na tentativa ${attempt + 1}:`, error.message);
            await new Promise((resolve) => setTimeout(resolve, delay)); // Aguarda antes da próxima tentativa
        }
    }
    throw lastError; // Lança o último erro após todas as tentativas falharem
}

// Mapeamento customizado
const customMappings = {
    nexcrm: { name: "Nex CRM", dns: "nexcrm.sistemasdevos.com.br" },
    HSM2: { dns: "hsm2.sistemasdevos.com.br",name: "HSM2" },
    cabralnovo: { dns: "vincitcrm.com.br", name: "Vincit" },
    joycebrun: { dns: "metodojb.sistemasdevos.com.br", name: "Metodo JB" },
    HST: { dns: "hst2.sistemasdevos.com.br", name: "HST Contingência" },
    espelho1: { dns: "hst.sistemasdevos.com.br", name: "HST" },
    SEDURB: { dns: "sedurbjp.sistemasdevos.com.br", name: "Smart Urban" },
    suporte: { dns: "suporte.sistemasdevos.com.br", name: "Suporte Devos" },
};

// Rota para obter instâncias
app.get("/instances", async (req, res) => {
    try {
        const instancesResponse = await lightsailClient.send(new GetInstancesCommand({}));
        const instances = instancesResponse.instances || [];
        const domainsResponse = await lightsailClient.send(new GetDomainsCommand({}));
        const domains = domainsResponse.domains || [];

        const detailedInstances = await Promise.all(
            instances.map(async (instance) => {
                const startTime = new Date(Date.now() - 5 * 60 * 1000);
                const endTime = new Date();

                const metricsData = await Promise.all(
                    METRICS.map(async (metric) => {
                        try {
                            return await fetchWithRetry(async () => {
                                const metricDataResponse = await lightsailClient.send(new GetInstanceMetricDataCommand({
                                    instanceName: instance.name,
                                    metricName: metric.name,
                                    period: metric.period,
                                    startTime,
                                    endTime,
                                    statistics: ["Average"],
                                    unit: metric.unit,
                                }));
                                let averageValue = metricDataResponse.metricData?.[0]?.average || "Sem dados";

                                // Converte "." para "," se for um número
                                if (typeof averageValue === "number") {
                                    averageValue = averageValue.toLocaleString("pt-BR", {
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2,
                                    });
                                }

                                return { [metric.name]: averageValue };
                            });
                        } catch (error) {
                            console.error(`Erro ao buscar métrica ${metric.name} para instância ${instance.name}:`, error);
                            return { [metric.name]: "Erro ao buscar dados" };
                        }
                    })
                );

                const metricsSummary = metricsData.reduce((acc, curr) => ({ ...acc, ...curr }), {});

                const diskDetails = instance.hardware.disks.map((disk) => ({
                    name: disk.name,
                    sizeInGb: disk.sizeInGb,
                    isSystemDisk: disk.isSystemDisk,
                    state: disk.state,
                    path: disk.path,
                    gbInUse: disk.gbInUse || "Sem dados",
                }));

                const associatedDomain = domains
                    .flatMap((domain) => domain.domainEntries || [])
                    .find((entry) => entry.target === instance.publicIpAddress);

                // Aplicação do mapeamento customizado
                const customMapping = customMappings[instance.name] || {};
                const name = customMapping.name || instance.name;
                const dns = customMapping.dns || associatedDomain?.name || "Sem domínio atribuído";

                return {
                    name,
                    state: instance.state?.name,
                    blueprint: instance.blueprintId,
                    bundle: instance.bundleId,
                    region: instance.location?.regionName,
                    publicIp: instance.publicIpAddress || "Sem IP atribuído",
                    dns,
                    metrics: metricsSummary,
                    disks: diskDetails,
                };
            })
        );

        res.json({ status: "success", data: detailedInstances });
    } catch (error) {
        console.error("Erro ao buscar instâncias ou domínios:", error);
        res.status(500).json({ status: "error", message: "Erro ao buscar instâncias ou domínios." });
    }
});


// Webhook para atualizar o servidor
app.post("/webhook", express.json(), (req, res) => {
    const secret = "minha-chave-secreta";
    const payload = JSON.stringify(req.body);

    if (!req.headers["x-hub-signature-256"]) {
        console.error("Assinatura requirida");
        return res.status(403).send("Assinatura requirida.");
    }

    const signature = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;

    if (req.headers["x-hub-signature-256"] !== signature) {
        console.error("Assinatura inválida.");
        return res.status(403).send("Assinatura inválida.");
    }

    console.log("Webhook recebido:", req.body);

    if (req.body.ref === "refs/heads/main") {
        exec("cd /opt/bitnami/projects/instancias && git pull && pm2 restart instancias", (err, stdout, stderr) => {
            if (err) {
                console.error(`Erro ao atualizar o servidor: ${stderr}`);
                return res.status(500).send("Erro ao atualizar o servidor.");
            }
            console.log(`Servidor atualizado: ${stdout}`);
            res.status(200).send("Servidor atualizado.");
        });
    } else {
        res.status(200).send("Nenhuma ação necessária.");
    }
});

// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
