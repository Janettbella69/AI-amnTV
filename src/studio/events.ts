import type { ServerResponse } from 'node:http';

export class StudioEvents {
  private readonly clients = new Set<ServerResponse>();

  subscribe(response: ServerResponse): () => void {
    this.clients.add(response);
    response.write(
      `event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`,
    );
    return () => this.clients.delete(response);
  }

  broadcast(event: string, value: unknown): void {
    const packet = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const client of this.clients) {
      if (client.destroyed || client.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      client.write(packet);
    }
  }

  close(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
