# Glossary

## Product
A family of models the counter chooses first — "One Piece Toilet", "Wash
Basin". Every sub product sits under exactly one product, and a product
belongs to one brand. A product is never itself sold; only its sub products
go on leads and orders.

## Sub product
One model inside a product — "102", "1111", "MAGENTA". This is what a lead
or order line quotes. It has its own printed name, an optional size, a
weight when somebody has entered one, a list of colours it is offered in,
and a print side. There is nothing under a sub product: no further form of
it to pick.

## Software code
The code staff quote for a sub product (`OPT-0001`), unique across the
catalogue. One sub product has exactly one. A product has a shorter code of
its own (`OPT`) that its sub products' codes are numbered from.

## Colour
One of the colours a sub product is offered in. A sub product offers none,
one, or several. None means its design is its own colour and nothing is
chosen or printed. One means that colour always applies. Several means the
counter picks per line, and two colours on one lead are two lines with a
quantity each. A colour that only repeats the sub product's own name
(`MAGENTA` in Magenta) is not printed beside it.

## Print side
Which half of a printed note a sub product belongs on: named models on the
left, plain codes on the right. Each sub product sets its own — **Left** or
**Right** — or leaves it at **Default**, which keeps the original rule: a
purely numeric name prints right, anything else left. A line freezes the
side it resolved to when it was taken, so changing the setting later never
moves an existing lead or order.
