import { useLocation, useSearchParams } from "react-router";

/**
 * `?feedback` on a task's page opens its Feedback tab, with the value (an audit's verdict, say)
 * already written in, so any view that finds a task wanting can send the person straight there.
 */
const PARAM = "feedback";

/** The task page's address with its Feedback tab open, and `text` written in. */
export function feedbackLink(taskUrl: string, text = ""): string {
  return `${taskUrl}?${PARAM}=${encodeURIComponent(text)}`;
}

/**
 * Whether the page was asked to open Feedback, and the text it was handed. `visit` changes on each
 * navigation, so asking again (Give Feedback after switching tabs) opens it again.
 */
export function useFeedbackRequest(): { asked: boolean; text: string; visit: string } {
  const [params] = useSearchParams();
  const { key } = useLocation();
  return { asked: params.has(PARAM), text: params.get(PARAM) ?? "", visit: key };
}
