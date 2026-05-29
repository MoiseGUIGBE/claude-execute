v/config";

  const opposite =
    signal === "LONG"
      ? "SELL"
      : "BUY";

  // ENTRY

  await privateRequest(
    "/fapi/v1/order",
    "POST",
    {
      symbol: SYMBOL,
      side,
      type: "MARKET",
      quantity,
    }
  );

  // STOP

  await privateRequest(
    "/fapi/v1/order",
    "POST",
    {
      symbol: SYMBOL,
      side: opposite,
      type: "STOP_MARKET",
      stopPrice: stop,
      closePosition: true,
      workingType: "MARK_PRICE",
    }
  );

  // TAKE PROFIT

  await privateRequest(
    "/fapi/v1/order",
    "POST",
    {
      symbol: SYMBOL,
      side: opposite,
      type: "TAKE_PROFIT_MARKET",
      stopPrice: target,
      closePosition: true,
      workingType: "MARK_PRICE",
    }
  );

  log("🚀 LIVE TRADE EXECUTED");

  await sendTelegram(
    `🚀 ${SYMBOL} ${signal}\nQty: ${quantity}`
  );
}

// =====================================================
// MAIN
// ==================================================
