import { Link } from "react-router";

/** The dari turtle mark, as shipped in the approved login mock. */
export function DariMark() {
  return (
    <svg
      className="selfbench-dari"
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="512" cy="512" r="461.94" fill="#11241d" />
      <g fill="#eafff4">
        <path d="M227.174 643.267C309.13 501.04 353.3 382.247 461.711 379.747c100.278 6.927 172.975 162.686 217.376 263.52h110.942c-81.304-117.797-196.325-301.555-326.906-303.36-166.044-4.954-236.495 312.426-235.949 303.36" />
        <path d="M657.933 552.765h177.78V487.33l-224.079 18.712 44.162 15.727zM327.444 446.849h14.02v89.346h-14.02z" />
        <path d="M368.884 403.285h13.92v129.377h-13.92z" />
        <path d="M413.178 382.234h13.886v144.712h-13.886zm48.935-4.033h13.886v144.712h-13.886z" />
        <path d="M525.783 410.11h.44v-.31h-.44zm-13.447.421v118.442h13.887V423.498a300 300 0 0 0-13.887-12.967" />
        <path d="m593.563 507.768-329.946 33.841-85.683 11.157h444.87c-9.563-15.205-19.29-30.327-29.241-44.998" />
      </g>
    </svg>
  );
}

/** "self-bench" over "by dari.dev", beside the mark. Links home. */
export function Lockup() {
  return (
    <Link className="lockup" to="/">
      <DariMark />
      <span className="name">
        <strong>self-bench</strong>
        <span className="by">by dari.dev</span>
      </span>
    </Link>
  );
}
