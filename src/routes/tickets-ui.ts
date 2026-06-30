import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { TicketStore } from "../db/store/ticket-store.js";

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export function createTicketsUiRouter(ticketStore: TicketStore): Router {
  const router = Router();

  router.get(
    "/tickets",
    asyncRoute(async (req, res) => {
      const includeResolved = req.query.includeResolved === "true";
      const tickets = await ticketStore.listTickets({ includeResolved });
      res.json({ tickets });
    }),
  );

  router.get(
    "/tickets/:ticketId",
    asyncRoute(async (req, res) => {
      const ticketId = Array.isArray(req.params.ticketId)
        ? req.params.ticketId[0]!
        : req.params.ticketId;
      const ticket = await ticketStore.getTicketWithMessages(ticketId);
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      res.json({ ticket });
    }),
  );

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  });

  return router;
}
