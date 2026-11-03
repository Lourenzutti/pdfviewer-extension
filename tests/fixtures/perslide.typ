// PowerPoint's PDF export bookmarks every slide as "Slide N: Title".
#set page(paper: "presentation-16-9")
#set text(size: 28pt)
#show heading: it => align(center, text(size: 48pt, it.body))

= Slide 1: Alpha
First.
#pagebreak()
= Slide 2: Beta
Second.
#pagebreak()
= Slide 3: Gamma
Third.
