import { ParetoPlot, type ParetoPlotProps } from "@mupt-ai/dari-pareto";
import { CHART_LOOK, VENDOR_CHIPS } from "../format";

/**
 * Both results charts, the repository page's and the app's Results popup, draw through this: the
 * same look and vendor chips, and each point's accuracy interval as an error bar.
 */
export function ResultsPlot(props: ParetoPlotProps) {
  return <ParetoPlot {...CHART_LOOK} {...VENDOR_CHIPS} {...props} />;
}
