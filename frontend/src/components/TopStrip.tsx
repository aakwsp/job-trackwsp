// The beige strip at the very top: credit, a hairline running to the right
// edge, and a small diamond to end it. `flex-1` on the line makes it take
// whatever width is left between the text and the diamond.
export default function TopStrip() {
  return (
    <div className="strip flex items-center gap-4 px-4 py-0.5">
      <span>designed by aakwsp // moshi</span>
      <span className="strip-rule flex-1" aria-hidden />
      <span className="strip-diamond" aria-hidden />
    </div>
  )
}
