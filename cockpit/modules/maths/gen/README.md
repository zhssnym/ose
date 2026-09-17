# The drills generator

`generate.py` writes one series of automatism questions into the vault, in the grammar of
`briefs/FORMAT-drills.md`. Python 3, standard library only, no sympy, no npm, nothing to
install. It is a desk tool: the `maths` module never runs it, has no `run` permission, and
does not know it exists. Hassan (or an agent working on the vault from outside) runs it by
hand every few days.

Everything a question needs is computed. A template draws its parameters at random from the
seed, the answer comes out of the arithmetic, and the three wrong options are the error
patterns of `1-erreurs.md` and the usual ones, never random values. `n² - 9` always offers
`(n-3)²`; `6^n / 2^n` always offers `4^n`, `3` and `6^{n-2}`; `2^{n+1} + 2^n` always offers
`2^{2n+1}` and `4^n`; a sign study always offers the wrong interval bound.

## Running it

```
python generate.py --out <1-drills> --serie 5 --date 2026-09-19 --count 70 --seed 5 \
    --weights puissances=16,suites=18,signes-inegalites=14,developpement-factorisation=12,fractions=10
```

It creates `<1-drills>/serie-05/serie.md`, validates what it wrote, and prints the counts per
family, the spread of the correct letter, and how many templates were used. It refuses to
leave an invalid file behind: if the check fails it prints the offending lines and exits 1.

- `--count` defaults to 70, `--duree` to 25, `--seed` to the series number.
- The weights are counts, not percentages. If they do not add up to `--count` they are scaled
  to it, largest remainder first. Without `--weights` the five families share equally.
- The same seed gives byte for byte the same file. Change the seed to get a different series
  with the same shape.
- No two questions of a series come from the same template with the same parameters, the
  families are interleaved (never three of the same in a row), and the correct letter is
  uniform over the series: 18/18/17/17 on 70 questions.

Checking a file, which anyone can do at any time:

```
python generate.py --check <1-drills>/serie-05/serie.md
python generate.py --list-templates
```

`--check` parses the grammar as `FORMAT-drills.md` states it and names the line of every
deviation: BOM, CRLF, missing final newline, two blank lines in a row, a header key that is
not `date`/`duree`/`familles`, a date that is not `YYYY-MM-DD`, a gap in the question
numbers, a family slug that is not lowercase ASCII with hyphens, a statement that is empty,
anything but exactly four options `A B C D` in order, two identical options, a missing or
malformed `<!-- reponse: X -->`, a `<!-- regle: … -->` that does not close on its line, and a
`familles` header that does not list the slugs in their order of first appearance.

## The families and their templates

Thirty-three templates. Every one carries its own `regle`, the one line the module shows in
the reprise of the misses.

**puissances** (8) — `puiss-meme-base` (a^{pn}/a^{qn}, including negative exponents),
`puiss-bases-quotient` (a^n/b^n, rule 1 of the post-mortem), `puiss-bases-produit`
(a^n × b^n), `puiss-somme` (a^{n+k} + a^n, rule 2), `puiss-parite` ((-1)^{mn+c}, rule 3),
`puiss-exposant-negatif` (1/a^n), `puiss-puissance-de-puissance` ((a^n)^k),
`puiss-exposant-fractionnaire` (√(a^{2n}) and (a^{2n})^{1/2}).

**suites** (7), the priority family, rule 5 — `suite-un1-quadratique` (u_n polynomial, what
is u_{n+1}), `suite-un1-quotient` (u_n a quotient), `suite-un1-geometrique` (u_n = k·b^n),
`suite-difference` (u_{n+1} - u_n), `suite-u2n` (u_{2n}), `suite-recurrence` (the first terms
of u_{n+1} = a·u_n + b), `suite-nature` (arithmetic or geometric, and why).

**signes-inegalites** (6) — `signe-inequation-negative` (dividing by a negative),
`signe-trinome-entiers` (n² - Sn + P < 0 over ℕ, where the answer is often "no natural
number"), `signe-affine-en-n` (from which rank is an - b positive), `signe-produit`,
`signe-quotient` (the forbidden value), `signe-expression-en-n` (the sign of an expression
for every n).

**developpement-factorisation** (6) — `dev-carre` ((ax ± b)²), `dev-difference-carres`,
`fact-difference-carres` (16 - 81x², 4n² - 25: the squares are not written as squares, rule
4), `fact-facteur-commun` (two surfaces), `fact-carre-parfait`, `dev-produit-general`.

**fractions** (6) — `frac-somme`, `frac-difference`, `frac-quotient`, `frac-simplifier`
((6n+9)/3), `frac-imbriquee`, `frac-litterale` (1/n ± 1/(n+a)).

## Adding a family or a template

A template is one function `t_nom(rng)` that returns a dict, or `None` when the parameters it
drew are unusable (then the generator draws again):

```python
{
  "famille": "puissances",
  "cle": "6-2",                  # the parameters: no two questions share one in a series
  "enonce": "Simplifier $\\dfrac{6^{n}}{2^{n}}$ pour $n$ entier naturel.",
  "regle": "bases différentes, même exposant : a^n / b^n = (a/b)^n",
  "correct": (latex, cle),       # the answer, COMPUTED
  "faux": [(latex, cle), (latex, cle), (latex, cle)],
}
```

The second half of each option is its key: two options are the same when their keys are
equal, and the generator throws the question away rather than ship two right answers. For an
expression, build the key with `sn(...)` or `sx(...)`, which sample the option at five values
of n or x; for a polynomial use `poly_opt(...)`, which keys on the coefficients; for a number
`frac_opt(...)`; for a sentence `mot(texte, cle)`. Never write a key by hand that does not
come from the same arithmetic as the LaTeX, or the guarantee is gone.

Then add `("nom-du-gabarit", t_nom)` to `GABARITS` under its family. A new family is a new
key in `GABARITS` with at least four templates; the slug must be lowercase ASCII with
hyphens, and `FORMAT-drills.md` already reserves `racines`, `logarithmes`, `exponentielle`,
`derivees` and `trigonometrie`. Nothing else to declare: `--weights` accepts it at once and
the module colours an unknown family by hash.

LaTeX is rendered by Temml in the module: `\dfrac` for fractions, braces around every
exponent (`a^{2n}`, never `a^2n`), `\times` for a product, `\leqslant` and `\geqslant`,
`\mathbb{N}`, `\left(` `\right)`, and no `\text` unless a sentence really has to live inside
the maths. A statement or an option with an odd number of `$` is refused by the checker.

## After five series: the next five

The module rewrites `.drills/bilan.md` after every session. It is a table, one row per family:
the median thinking time over the last five series with its trend against the five before, the
accuracy over the same, and under it every miss as `serie · n · famille · attendu · choisi ·
règle`. Read it, then reweight towards the families where the median time is still high. The
score is not the measure; the time is.

The rule for the new weights, 70 questions over five families:

1. Give every family a floor of 8.
2. Share the remaining 30 in proportion to `mediane_reflexion_ms × (1 + taux d'erreur)`,
   taken from the table.
3. Round to whole questions, largest remainder first, and cap any family at 20 so a series
   never becomes a single subject.

Then, from the vault root, for the five days that follow:

```
cd 2-learning/1-school/1-math/1-drills
G=../../../../.ose/app/modules/maths/gen/generate.py
W=puissances=12,suites=20,signes-inegalites=16,developpement-factorisation=12,fractions=10
python $G --out . --serie 5 --date 2026-09-19 --count 70 --seed 5 --weights $W
python $G --out . --serie 6 --date 2026-09-20 --count 70 --seed 6 --weights $W
python $G --out . --serie 7 --date 2026-09-21 --count 70 --seed 7 --weights $W
python $G --out . --serie 8 --date 2026-09-22 --count 70 --seed 8 --weights $W
python $G --out . --serie 9 --date 2026-09-23 --count 70 --seed 9 --weights $W
```

(the `--weights` above is the example, not a constant: it is what step 2 gave that day, and
`--date` is the day each series is meant to be sat). Every run prints `OK` for the file it
wrote; if one prints lines instead, the file is invalid and nothing else should be trusted
until it is fixed.
