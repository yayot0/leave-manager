import { apiFetch } from "./client";
import type { VacationBalance, VacationBalanceResponse } from "./types";

export async function getMyBalance(signal?: AbortSignal): Promise<VacationBalance> {
  const { balance } = await apiFetch<VacationBalanceResponse>("/me/balance", { signal });
  return balance;
}
