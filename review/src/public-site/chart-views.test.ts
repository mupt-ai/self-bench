import { describe, expect, test } from "bun:test";
import { minutesTick, viewAxes, viewPoint } from "./chart-views";
import { minutesText } from "./format";

const measure = { accuracy: 70, cost: 0.5, minutes: 12 };

describe("viewPoint", () => {
  test("accuracy against cost places cost across, as the chart always has", () => {
    expect(viewPoint("accuracy-cost", measure)).toEqual({ x: 0.5, y: 70 });
  });

  test("time views place time across and need timed attempts", () => {
    expect(viewPoint("accuracy-time", measure)).toEqual({ x: 12, y: 70 });
    expect(viewPoint("accuracy-time", { ...measure, minutes: undefined })).toBeUndefined();
  });

  test("the time view keeps a measure that recorded no spend", () => {
    expect(viewPoint("accuracy-time", { ...measure, cost: 0 })).toEqual({ x: 12, y: 70 });
  });
});

describe("viewAxes", () => {
  test("each view's axes match its name", () => {
    expect(viewAxes("accuracy-cost", { lowestAccuracy: 40, narrow: false }).xAxis).toMatchObject({
      scale: "log",
    });
    const time = viewAxes("accuracy-time", { lowestAccuracy: 40, narrow: false });
    expect(time.xAxis).toMatchObject({ label: "Time per Task", objective: "minimize" });
    expect(time.xAxis).not.toHaveProperty("scale");
    expect(time.yAxis).toMatchObject({ label: "Accuracy", objective: "maximize" });
  });

  test("the accuracy domain starts below the lowest point, in tens", () => {
    const { yAxis } = viewAxes("accuracy-time", { lowestAccuracy: 47, narrow: false });
    expect(yAxis).toMatchObject({ domain: [30, 104] });
  });
});

describe("time text", () => {
  test("ticks and trial durations use the same breaks", () => {
    expect(minutesTick(45)).toBe("45 min");
    expect(minutesTick(120)).toBe("2 h");
    expect(minutesText(0.5)).toBe("<1 min");
    expect(minutesText(12.4)).toBe("12 min");
    expect(minutesText(125)).toBe("2 h 5 min");
  });
});
