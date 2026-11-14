import { isNode, isScalar, parse, parseDocument, stringify, visit } from "yaml";

// A pasted compose lives in the Cliente's shared .panel/ directory, so its
// `env_file: .env` has to point at the Proyecto's own file instead.
export function apuntarEnvFile(content: string, fichero: string): string {
  const doc = parseDocument(content);
  // An invalid compose fails in `docker compose` with its own error.
  if (doc.errors.length) return content;
  let cambiado = false;
  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== "env_file") return;
      if (!isNode(pair.value)) return;
      visit(pair.value, {
        Scalar(_, nodo) {
          if (nodo.value !== ".env" && nodo.value !== "./.env") return;
          nodo.value = fichero;
          cambiado = true;
        },
      });
    },
  });
  // Untouched when there is nothing to change, to keep the user's formatting.
  return cambiado ? doc.toString() : content;
}

export function extraerServicios(content: string): string[] {
  if (!content.trim()) return [];
  try {
    const doc = parse(content) as Record<string, unknown>;
    const services = doc?.services;
    if (!services || typeof services !== "object") return [];
    return Object.keys(services);
  } catch {
    return [];
  }
}

function puertoContenedorDe(entrada: unknown): number | undefined {
  // formatos válidos en expose/ports: 8000, "8000", "8000/tcp", "8000:8000",
  // "127.0.0.1:8000:8000" — el puerto de contenedor es siempre el último tramo.
  const ultimoTramo = String(entrada).split(":").at(-1) ?? "";
  const puerto = Number(ultimoTramo.split("/")[0]);
  return Number.isFinite(puerto) ? puerto : undefined;
}

// Varios servicios de un mismo compose pueden compartir imagen (p. ej. web/worker/beat
// construidos del mismo Dockerfile con EXPOSE 8000) — el puerto expuesto por Docker no
// basta para distinguir cuál sirve HTTP realmente. El nombre de servicio que declara ese
// puerto en el propio YAML sí lo identifica, vía la label com.docker.compose.service.
export function encontrarServicioPorPuerto(
  content: string,
  puerto: number,
): string | undefined {
  if (!content.trim()) return undefined;
  try {
    const doc = parse(content) as Record<string, unknown>;
    const services = doc?.services;
    if (!services || typeof services !== "object") return undefined;
    for (const [nombre, definicion] of Object.entries(
      services as Record<string, unknown>,
    )) {
      const { expose, ports } = (definicion ?? {}) as {
        expose?: unknown[];
        ports?: unknown[];
      };
      const declarados = [...(expose ?? []), ...(ports ?? [])];
      if (declarados.some((d) => puertoContenedorDe(d) === puerto))
        return nombre;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Docker keeps container logs forever by default; a chatty container fills
// the VPS disk. 3 × 10 MB per container is plenty for the logs viewer.
export const LIMITE_LOGS = {
  driver: "json-file",
  options: { "max-size": "10m", "max-file": "3" },
} as const;

export function generarOverrideLogging(content: string): string | null {
  let services: unknown;
  try {
    services = (parse(content) as { services?: unknown } | null)?.services;
  } catch {
    // An invalid compose fails in `docker compose` with its own error.
    return null;
  }
  if (!services || typeof services !== "object") return null;
  const sinLimite = Object.entries(
    services as Record<string, { logging?: unknown } | null>,
  ).filter(([, definicion]) => !definicion?.logging);
  if (!sinLimite.length) return null;
  const override = Object.fromEntries(
    sinLimite.map(([nombre]) => [nombre, { logging: LIMITE_LOGS }]),
  );
  return stringify({ services: override }, { aliasDuplicateObjects: false });
}

// Plantilla de Proyecto WordPress: what every WordPress here needs and was
// being set up by hand. ${DB_PASSWORD} and ${DB_ROOT_PASSWORD} are created as
// variables of the Proyecto, with random values, when it is created.
// - Named volumes, so the backups of Proyectos pick up the database and
//   wp-content on their own.
// - PHP's default upload limit is 2 MB: raised before Apache starts.
// - The official image already trusts X-Forwarded-Proto, which Traefik sends.
export const PLANTILLA_WORDPRESS = `services:
  wordpress:
    image: wordpress:6-apache
    restart: unless-stopped
    command:
      - sh
      - -c
      - >-
        echo 'upload_max_filesize=64M' > /usr/local/etc/php/conf.d/subidas.ini &&
        echo 'post_max_size=64M' >> /usr/local/etc/php/conf.d/subidas.ini &&
        exec docker-entrypoint.sh apache2-foreground
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: "\${DB_PASSWORD}"
    volumes:
      - wp-content:/var/www/html/wp-content
    expose:
      - "80"
    depends_on:
      db:
        condition: service_healthy
    mem_limit: 1g
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: "\${DB_PASSWORD}"
      MARIADB_ROOT_PASSWORD: "\${DB_ROOT_PASSWORD}"
    volumes:
      - db-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 12
    mem_limit: 1g
volumes:
  wp-content:
  db-data:
`;
