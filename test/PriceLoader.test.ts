import { describe, expect, test } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PriceLoader } from "../src";

function tmp(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticks-"));
  const file = path.join(dir, "t.csv");
  fs.writeFileSync(file, content);
  return file;
}

describe("PriceLoader.loadTicks", () => {
  test("Binance trades WITH header (id,price,qty,quote_qty,time,is_buyer_maker)", () => {
    const f = tmp(
      "id,price,qty,quote_qty,time,is_buyer_maker\n" +
        "1,23175.5,0.001,23.17,1677283200087,true\n" +
        "2,23176.0,0.002,46.35,1677283200090,false\n"
    );
    const ticks = PriceLoader.loadTicks(f);
    expect(ticks).toEqual([
      { time: 1677283200087, price: 23175.5 },
      { time: 1677283200090, price: 23176.0 },
    ]);
  });

  test("Binance trades WITHOUT header (first row is data)", () => {
    const f = tmp(
      "524632412,54125.55,0.036,1948.51,1614038400011,false\n" +
        "524632413,54127.05,0.042,2273.33,1614038400012,false\n"
    );
    const ticks = PriceLoader.loadTicks(f);
    expect(ticks.length).toBe(2);
    expect(ticks[0]).toEqual({ time: 1614038400011, price: 54125.55 });
    expect(ticks[1]).toEqual({ time: 1614038400012, price: 54127.05 });
  });

  test("Binance aggTrades WITH header (transact_time column)", () => {
    const f = tmp(
      "agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n" +
        "3273510278,76305.4,0.001,7617942158,7617942158,1777593600217,true\n" +
        "3273510279,76305.5,0.006,7617942159,7617942162,1777593600582,false\n"
    );
    expect(PriceLoader.loadTicks(f)).toEqual([
      { time: 1777593600217, price: 76305.4 },
      { time: 1777593600582, price: 76305.5 },
    ]);
  });

  test("Binance aggTrades WITHOUT header (epoch auto-detected, not the trade ids)", () => {
    const f = tmp("3273510278,76305.4,0.001,7617942158,7617942158,1777593600217,true\n");
    expect(PriceLoader.loadTicks(f)).toEqual([{ time: 1777593600217, price: 76305.4 }]);
  });

  test("simple unix,price", () => {
    const f = tmp("unix,price\n1614038400011,100\n1614038400012,101\n");
    expect(PriceLoader.loadTicks(f).map((t) => t.price)).toEqual([100, 101]);
  });

  test("Gemini trade-prints (unix,TradeDate,symbol,price,…)", () => {
    const f = tmp(
      "unix,TradeDate,symbol,price,amount,type,trans_id\n" +
        "1579225081686,2020-01-17,BTCUSD,8693.36,0.001,sell,9\n"
    );
    expect(PriceLoader.loadTicks(f)).toEqual([
      { time: 1579225081686, price: 8693.36 },
    ]);
  });

  test("seconds timestamps are normalised to milliseconds", () => {
    const f = tmp("timestamp,price\n1600000000,100\n");
    expect(PriceLoader.loadTicks(f)[0].time).toBe(1600000000000);
  });

  test("limit reads only the first N rows", () => {
    const f = tmp(
      "id,price,qty,quote_qty,time,is_buyer_maker\n" +
        "1,10,1,10,1614038400001,true\n" +
        "2,11,1,11,1614038400002,true\n" +
        "3,12,1,12,1614038400003,true\n"
    );
    expect(PriceLoader.loadTicks(f, 2).length).toBe(2);
  });

  test("throws on an unrecognised format", () => {
    const f = tmp("foo,bar\nhello,world\n");
    expect(() => PriceLoader.loadTicks(f)).toThrow(
      "could not find time/price columns"
    );
  });
});
