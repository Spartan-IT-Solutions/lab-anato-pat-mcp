import pg from 'pg';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError
} from "@modelcontextprotocol/sdk/types.js";

const { Pool } = pg;

// Conexión a PostgreSQL
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5435'),
    database: process.env.DB_DATABASE || 'laboratorio',
    user: process.env.DB_USERNAME || 'sail',
    password: process.env.DB_PASSWORD || 'password',
});

// Verificar conexión al arrancar
try {
    const client = await pool.connect();
    client.release();
    console.error("✅ Conexión a PostgreSQL OK");
} catch (err) {
    console.error("❌ Error conectando a PostgreSQL:", err.message);
    process.exit(1);
}

const server = new Server(
    {
        name: "lab-anato-pat-mcp",
        version: "1.0.0"
    },
    {
        capabilities: {
            tools: {}
        }
    }
);

// ─── DECLARACIÓN DE TOOLS ───────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "pacientes_total",
                description: "Obtiene el total de pacientes registrados en el sistema. Puede filtrar por habilitados o todos.",
                inputSchema: {
                    type: "object",
                    properties: {
                        solo_habilitados: {
                            type: "boolean",
                            description: "Si es true, cuenta solo pacientes habilitados. Default: true"
                        }
                    },
                    required: []
                }
            },
            {
                name: "estudios_pendientes",
                description: "Lista estudios que aún no fueron entregados, con paciente y fecha de ingreso.",
                inputSchema: {
                    type: "object",
                    properties: {
                        desde: {
                            type: "string",
                            description: "Fecha desde (YYYY-MM-DD). Opcional."
                        },
                        hasta: {
                            type: "string",
                            description: "Fecha hasta (YYYY-MM-DD). Opcional."
                        }
                    },
                    required: []
                }
            },
            {
                name: "protocolos_pap",
                description: "Cuenta protocolos PAP generados en un período.",
                inputSchema: {
                    type: "object",
                    properties: {
                        desde: {
                            type: "string",
                            description: "Fecha desde (YYYY-MM-DD)"
                        },
                        hasta: {
                            type: "string",
                            description: "Fecha hasta (YYYY-MM-DD)"
                        }
                    },
                    required: ["desde", "hasta"]
                }
            },
            {
                name: "buscar_paciente",
                description: "Busca pacientes por apellido, nombre o número de documento.",
                inputSchema: {
                    type: "object",
                    properties: {
                        texto: {
                            type: "string",
                            description: "Texto a buscar en apellidos, nombres o número de documento"
                        }
                    },
                    required: ["texto"]
                }
            }
        ]
    };
});

// ─── EJECUCIÓN DE TOOLS ─────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {

        // ── pacientes_total ──────────────────────────────────────────────────
        if (name === "pacientes_total") {
            const soloHabilitados = args?.solo_habilitados !== false;
            const sql = soloHabilitados
                ? `SELECT COUNT(*) as total FROM paciente WHERE habilitado = true AND deleted_at IS NULL`
                : `SELECT COUNT(*) as total FROM paciente WHERE deleted_at IS NULL`;

            const result = await pool.query(sql);
            const total = result.rows[0].total;

            return {
                content: [{
                    type: "text",
                    text: `Total de pacientes ${soloHabilitados ? 'habilitados' : 'registrados'}: ${total}`
                }]
            };
        }

        // ── estudios_pendientes ──────────────────────────────────────────────
        if (name === "estudios_pendientes") {
            let sql = `
                SELECT
                    e.protocolo,
                    e.fecha_ingreso,
                    e.fecha_prometido,
                    p.apellidos || ', ' || p.nombres AS paciente,
                    es.nombre AS estado
                FROM estudio e
                JOIN ingreso i ON i.id = e.ingreso_id
                JOIN paciente p ON p.id = i.paciente_id
                JOIN estado es ON es.id = e.estado_id
                WHERE e.fecha_entrega IS NULL
                AND e.deleted_at IS NULL
            `;
            const params = [];

            if (args?.desde) {
                params.push(args.desde);
                sql += ` AND e.fecha_ingreso >= $${params.length}`;
            }
            if (args?.hasta) {
                params.push(args.hasta);
                sql += ` AND e.fecha_ingreso <= $${params.length}`;
            }

            sql += ` ORDER BY e.fecha_ingreso ASC LIMIT 50`;

            const result = await pool.query(sql, params);

            if (result.rows.length === 0) {
                return {
                    content: [{ type: "text", text: "No hay estudios pendientes para el período indicado." }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Estudios pendientes (${result.rows.length}):\n\n` +
                        JSON.stringify(result.rows, null, 2)
                }]
            };
        }

        // ── protocolos_pap ───────────────────────────────────────────────────
        if (name === "protocolos_pap") {
            if (!args?.desde || !args?.hasta) {
                throw new McpError(ErrorCode.InvalidParams, "Se requieren 'desde' y 'hasta'");
            }

            const sql = `
                SELECT COUNT(*) as total
                FROM pap p
                JOIN estudio e ON e.id = p.estudio_id
                WHERE e.fecha_ingreso BETWEEN $1 AND $2
                AND p.deleted_at IS NULL
            `;

            const result = await pool.query(sql, [args.desde, args.hasta]);
            const total = result.rows[0].total;

            return {
                content: [{
                    type: "text",
                    text: `Protocolos PAP generados entre ${args.desde} y ${args.hasta}: ${total}`
                }]
            };
        }

        // ── buscar_paciente ──────────────────────────────────────────────────
        if (name === "buscar_paciente") {
            if (!args?.texto) {
                throw new McpError(ErrorCode.InvalidParams, "Se requiere el parámetro 'texto'");
            }

            const busqueda = `%${args.texto}%`;
            const sql = `
                SELECT
                    p.codigo,
                    p.apellidos,
                    p.nombres,
                    p.numero_documento,
                    p.telefono,
                    p.datos_validados,
                    p.habilitado
                FROM paciente p
                WHERE (
                    p.apellidos ILIKE $1
                    OR p.nombres ILIKE $1
                    OR p.numero_documento ILIKE $1
                )
                AND p.deleted_at IS NULL
                ORDER BY p.apellidos, p.nombres
                LIMIT 20
            `;

            const result = await pool.query(sql, [busqueda]);

            if (result.rows.length === 0) {
                return {
                    content: [{ type: "text", text: `No se encontraron pacientes con "${args.texto}".` }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Pacientes encontrados (${result.rows.length}):\n\n` +
                        JSON.stringify(result.rows, null, 2)
                }]
            };
        }

        throw new McpError(ErrorCode.MethodNotFound, `Tool no encontrada: ${name}`);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
            isError: true
        };
    }
});

// ─── ARRANQUE ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("🚀 lab-anato-pat MCP Server corriendo en stdio");
