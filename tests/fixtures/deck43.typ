// 4:3 test deck: 3 slides.
#set page(paper: "presentation-4-3", margin: 1.5cm, fill: rgb("#eef4ff"))
#set text(size: 28pt)

#for n in range(1, 4) [
  #align(center + horizon)[#text(size: 64pt, weight: "bold")[Square #n]]
  #if n < 3 { pagebreak() }
]
