// 16:9 test deck: 6 slides, one external link, one internal link.
#set page(paper: "presentation-16-9", margin: 1.5cm, fill: rgb("#fdfdf8"))
#set text(size: 28pt)

#let slide(n, body) = [
  #align(center + horizon)[
    #text(size: 64pt, weight: "bold")[Slide #n]
    #v(0.5cm)
    #body
  ]
  #pagebreak(weak: true)
]

#slide(1)[Intro #link("https://example.com/external")[External link]]
#slide(2)[Second #link(<target>)[Jump to slide 5]]
#slide(3)[Third]
#slide(4)[Fourth]
#slide(5)[#[Fifth (target)] <target>]
#align(center + horizon)[#text(size: 64pt, weight: "bold")[Slide 6] \ Last]
