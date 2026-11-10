import { Request, Response } from 'express';

interface Client {
  id: string;
  res: Response;
  userId: string;
}

class AIEventStreamService {
  private clients: Client[] = [];

  public handleConnection(req: Request, res: Response, userId: string) {
    const headers = {
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache'
    };
    res.writeHead(200, headers);

    const clientId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const newClient: Client = {
      id: clientId,
      res,
      userId
    };

    this.clients.push(newClient);
    console.log(`[AI Event Stream] Client connected: ${clientId} for user ${userId}`);

    // Send initial connected event
    this.sendToUser(userId, { type: 'CONNECTED', message: 'SSE connection established' });

    req.on('close', () => {
      console.log(`[AI Event Stream] Client disconnected: ${clientId}`);
      this.clients = this.clients.filter(client => client.id !== clientId);
    });
  }

  public sendToUser(userId: string, data: any) {
    const userClients = this.clients.filter(client => client.userId === userId);
    userClients.forEach(client => {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
  }

  public broadcast(data: any) {
    this.clients.forEach(client => {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
  }
}

export const aiEventStreamService = new AIEventStreamService();
