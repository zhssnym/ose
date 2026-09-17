#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Générateur de séries d'automatismes de calcul.

Python 3, bibliothèque standard seulement. Le plugin ne lance jamais ce script :
c'est un outil de bureau, lancé à la main (ou par un agent) tous les quelques jours.
Une série est un fichier : <dossier>/serie-NN.md.

    python generate.py --out <dossier des séries> --serie 2 --date 2026-09-16 \
        --count 70 --seed 2 \
        --weights puissances=16,suites=18,signes-inegalites=14,\
developpement-factorisation=12,fractions=10

    python generate.py --check <dossier>/serie-02.md

Chaque question sort d'un gabarit à paramètres tirés au sort ; la bonne réponse est
calculée, jamais écrite à la main, et les trois distracteurs sont les erreurs réelles
de 1-erreurs.md (ou les erreurs classiques), jamais des valeurs au hasard.
"""

from __future__ import annotations

import argparse
import random
import re
import sys
from fractions import Fraction
from math import gcd
from pathlib import Path

FAMILLES_CONNUES = [
    "puissances",
    "fractions",
    "developpement-factorisation",
    "signes-inegalites",
    "suites",
    "racines",
    "logarithmes",
    "exponentielle",
    "derivees",
    "trigonometrie",
]

LETTRES = ["A", "B", "C", "D"]

# Points d'échantillonnage : deux options sont « la même » si elles prennent les
# mêmes valeurs en tous ces points. C'est ce qui garantit qu'aucune proposition
# n'est égale à une autre après simplification.
NPTS = (1, 2, 3, 4, 5)
XPTS = (Fraction(1, 3), Fraction(2), Fraction(-1), Fraction(7, 2), Fraction(5))


# --------------------------------------------------------------------------- #
# petits outils                                                                #
# --------------------------------------------------------------------------- #


def sample(fn, pts):
    """La signature numérique d'une expression : ses valeurs aux points donnés."""
    out = []
    for p in pts:
        try:
            v = fn(p)
        except (ZeroDivisionError, ValueError, OverflowError):
            v = None
        out.append(Fraction(v) if v is not None else None)
    return tuple(out)


def sn(fn):
    return sample(fn, NPTS)


def sx(fn):
    return sample(fn, XPTS)


def num_latex(v):
    """Un nombre en LaTeX : entier brut, fraction en \\dfrac."""
    v = Fraction(v)
    if v.denominator == 1:
        return str(v.numerator)
    signe = "-" if v < 0 else ""
    return signe + "\\dfrac{" + str(abs(v.numerator)) + "}{" + str(v.denominator) + "}"


def poly_latex(termes, var="n"):
    """termes : [(coefficient, puissance), ...] du plus haut degré au plus bas."""
    out = ""
    for c, p in termes:
        c = Fraction(c)
        if c == 0:
            continue
        neg = c < 0
        a = abs(c)
        if p == 0:
            corps = num_latex(a)
        else:
            base = var if p == 1 else var + "^{" + str(p) + "}"
            corps = base if a == 1 else num_latex(a) + base
        if out == "":
            out = ("-" + corps) if neg else corps
        else:
            out += (" - " if neg else " + ") + corps
    return out or "0"


def poly_val(termes):
    def f(t):
        s = Fraction(0)
        for c, p in termes:
            s += Fraction(c) * (Fraction(t) ** p)
        return s

    return f


def poly_opt(termes, var="n"):
    """Une proposition polynomiale : son LaTeX et sa clé (les coefficients)."""
    cle = tuple(sorted((int(p), Fraction(c)) for c, p in termes if Fraction(c) != 0))
    return ("$" + poly_latex(termes, var) + "$", ("poly", cle))


def expo(m, var="n"):
    """L'exposant m*n, écrit comme on l'écrit : n, -n, 3n, -2n."""
    if m == 1:
        return var
    if m == -1:
        return "-" + var
    return str(m) + var


def frac_opt(v):
    return ("$" + num_latex(v) + "$", ("nb", Fraction(v)))


def mot(txt, cle):
    """Une proposition en toutes lettres (intervalle, nature d'une suite, signe)."""
    return (txt, cle)


# --------------------------------------------------------------------------- #
# famille : puissances                                                         #
# --------------------------------------------------------------------------- #

PQ = [(1, 2), (2, 1), (1, 3), (3, 1), (2, 3), (3, 2), (4, 1), (1, 4), (3, 4), (4, 3), (2, 4), (4, 2)]


def t_puiss_meme_base(rng):
    a = rng.choice([2, 3, 5, 7, 10])
    p, q = rng.choice(PQ)
    e = p - q
    enonce = (
        "Simplifier $\\dfrac{" + str(a) + "^{" + expo(p) + "}}{" + str(a) + "^{" + expo(q) + "}}$ "
        "pour $n$ entier naturel."
    )
    correct = ("$" + str(a) + "^{" + expo(e) + "}$", sn(lambda n: Fraction(a) ** (e * n)))
    faux = [
        ("$" + str(a) + "^{" + expo(p + q) + "}$", sn(lambda n: Fraction(a) ** ((p + q) * n))),
        ("$" + str(a) + "^{" + expo(p * q) + "}$", sn(lambda n: Fraction(a) ** ((p * q) * n))),
        (
            "$" + (str(a) if e == 1 else str(a) + "^{" + str(e) + "}") + "$",
            sn(lambda n: Fraction(a) ** e),
        ),
    ]
    return {
        "famille": "puissances",
        "cle": "%d-%d-%d" % (a, p, q),
        "enonce": enonce,
        "regle": "même base : a^p / a^q = a^{p-q}, on soustrait les exposants",
        "correct": correct,
        "faux": faux,
    }


QUOTIENTS = [
    (6, 2), (8, 2), (9, 3), (10, 2), (10, 5), (12, 3), (12, 4), (14, 2), (15, 3), (15, 5),
    (20, 4), (21, 3), (8, 4), (6, 3), (18, 2), (18, 3), (18, 6), (20, 5), (16, 8), (24, 6),
    (22, 2), (26, 2), (27, 9), (35, 5), (33, 3),
]


def t_puiss_bases_quotient(rng):
    a, b = rng.choice(QUOTIENTS)
    q = a // b
    if a - b == q:
        return None
    enonce = (
        "Simplifier $\\dfrac{" + str(a) + "^{n}}{" + str(b) + "^{n}}$ pour $n$ entier naturel."
    )
    correct = ("$" + str(q) + "^{n}$", sn(lambda n: Fraction(q) ** n))
    faux = [
        ("$" + str(a - b) + "^{n}$", sn(lambda n: Fraction(a - b) ** n)),
        ("$" + str(q) + "$", sn(lambda n: Fraction(q))),
        ("$" + str(a) + "^{n-" + str(b) + "}$", sn(lambda n: Fraction(a) ** (n - b))),
    ]
    return {
        "famille": "puissances",
        "cle": "%d-%d" % (a, b),
        "enonce": enonce,
        "regle": "bases différentes, même exposant : a^n / b^n = (a/b)^n",
        "correct": correct,
        "faux": faux,
    }


def t_puiss_bases_produit(rng):
    a = rng.choice([2, 3, 4, 5, 6, 7])
    b = rng.choice([2, 3, 4, 5, 6, 7, 10])
    if a == b or a * b == a + b:
        return None
    ab = a * b
    enonce = (
        "Écrire $" + str(a) + "^{n} \\times " + str(b) + "^{n}$ sous la forme d'une seule puissance."
    )
    correct = ("$" + str(ab) + "^{n}$", sn(lambda n: Fraction(ab) ** n))
    faux = [
        ("$" + str(a + b) + "^{n}$", sn(lambda n: Fraction(a + b) ** n)),
        ("$" + str(ab) + "^{2n}$", sn(lambda n: Fraction(ab) ** (2 * n))),
        ("$" + str(ab) + "^{n^{2}}$", sn(lambda n: Fraction(ab) ** (n * n))),
    ]
    return {
        "famille": "puissances",
        "cle": "%d-%d" % (min(a, b), max(a, b)),
        "enonce": enonce,
        "regle": "même exposant : a^n × b^n = (ab)^n, on multiplie les bases",
        "correct": correct,
        "faux": faux,
    }


def t_puiss_somme(rng):
    a = rng.choice([2, 3, 5])
    k = rng.choice([1, 1, 2])
    c = a ** k + 1
    enonce = (
        "Simplifier $" + str(a) + "^{n+" + str(k) + "} + " + str(a) + "^{n}$ "
        "pour $n$ entier naturel."
    )
    correct = (
        "$" + str(c) + " \\times " + str(a) + "^{n}$",
        sn(lambda n: Fraction(c) * Fraction(a) ** n),
    )
    faux = [
        ("$" + str(a) + "^{2n+" + str(k) + "}$", sn(lambda n: Fraction(a) ** (2 * n + k))),
        ("$" + str(a * a) + "^{n}$", sn(lambda n: Fraction(a * a) ** n)),
        (
            "$" + str(a ** k) + " \\times " + str(a) + "^{n}$",
            sn(lambda n: Fraction(a ** k) * Fraction(a) ** n),
        ),
    ]
    return {
        "famille": "puissances",
        "cle": "%d-%d" % (a, k),
        "enonce": enonce,
        "regle": "on factorise une somme de puissances par la plus petite : 2^{n+1} + 2^n = 2^n(2+1)",
        "correct": correct,
        "faux": faux,
    }


def t_puiss_parite(rng):
    m = rng.choice([2, 2, 4, 3, 5])
    c = rng.choice([0, 0, 1, 2, 3])
    ex = expo(m)
    if c:
        ex += " + " + str(c)
    enonce = "Que vaut $(-1)^{" + ex + "}$ pour $n$ entier naturel ?"
    sym_n = ("$(-1)^{n}$", sn(lambda n: Fraction((-1) ** n)))
    sym_n1 = ("$(-1)^{n+1}$", sn(lambda n: Fraction((-1) ** (n + 1))))
    un = ("$1$", sn(lambda n: Fraction(1)))
    moins_un = ("$-1$", sn(lambda n: Fraction(-1)))
    if m % 2 == 0:
        v = (-1) ** c
        correct = un if v == 1 else moins_un
        faux = [moins_un if v == 1 else un, sym_n, sym_n1]
        regle = "(-1)^p vaut 1 si p est pair et -1 si p est impair : seule la parité de l'exposant compte"
    else:
        correct = sym_n if c % 2 == 0 else sym_n1
        faux = [sym_n1 if c % 2 == 0 else sym_n, un, moins_un]
        regle = "(-1)^{3n} = (-1)^n : seule la parité de l'exposant compte"
    return {
        "famille": "puissances",
        "cle": "%d-%d" % (m, c),
        "enonce": enonce,
        "regle": regle,
        "correct": correct,
        "faux": faux,
    }


def t_puiss_exposant_negatif(rng):
    a = rng.choice([2, 3, 5, 7, 10])
    m = rng.choice([1, 1, 2, 3])
    ex = expo(m)
    enonce = (
        "Écrire $\\dfrac{1}{" + str(a) + "^{" + ex + "}}$ sous forme d'une puissance de $"
        + str(a) + "$."
    )
    correct = ("$" + str(a) + "^{" + expo(-m) + "}$", sn(lambda n: Fraction(a) ** (-m * n)))
    faux = [
        ("$-" + str(a) + "^{" + ex + "}$", sn(lambda n: -(Fraction(a) ** (m * n)))),
        ("$(-" + str(a) + ")^{" + ex + "}$", sn(lambda n: Fraction(-a) ** (m * n))),
        ("$" + str(a) + "^{1-" + ex + "}$", sn(lambda n: Fraction(a) ** (1 - m * n))),
    ]
    return {
        "famille": "puissances",
        "cle": "%d-%d" % (a, m),
        "enonce": enonce,
        "regle": "1/a^n = a^{-n} : c'est l'exposant qui change de signe, pas le nombre",
        "correct": correct,
        "faux": faux,
    }


def t_puiss_puissance_de_puissance(rng):
    a = rng.choice([2, 3, 5, 7])
    k = rng.choice([2, 3])
    if k * a == a ** k:
        return None
    enonce = "Simplifier $\\left(" + str(a) + "^{n}\\right)^{" + str(k) + "}$."
    correct = ("$" + str(a) + "^{" + expo(k) + "}$", sn(lambda n: Fraction(a) ** (k * n)))
    faux = [
        ("$" + str(a) + "^{n+" + str(k) + "}$", sn(lambda n: Fraction(a) ** (n + k))),
        ("$" + str(a) + "^{n^{" + str(k) + "}}$", sn(lambda n: Fraction(a) ** (n ** k))),
        ("$" + str(k * a) + "^{n}$", sn(lambda n: Fraction(k * a) ** n)),
    ]
    return {
        "famille": "puissances",
        "cle": "%d-%d" % (a, k),
        "enonce": enonce,
        "regle": "(a^p)^q = a^{pq} : on multiplie les exposants",
        "correct": correct,
        "faux": faux,
    }


def t_puiss_exposant_fractionnaire(rng):
    a = rng.choice([2, 3, 4, 5, 7, 9])
    forme = rng.choice(["racine", "exposant"])
    if forme == "racine":
        gauche = "\\sqrt{" + str(a) + "^{2n}}"
    else:
        gauche = "\\left(" + str(a) + "^{2n}\\right)^{\\frac{1}{2}}"
    enonce = "Simplifier $" + gauche + "$ pour $n$ entier naturel."
    correct = ("$" + str(a) + "^{n}$", sn(lambda n: Fraction(a) ** n))
    faux = [
        ("$" + str(a) + "^{4n}$", sn(lambda n: Fraction(a) ** (4 * n))),
        ("$" + str(a) + "^{n^{2}}$", sn(lambda n: Fraction(a) ** (n * n))),
        (
            "$\\dfrac{" + str(a) + "^{2n}}{2}$",
            sn(lambda n: Fraction(a) ** (2 * n) / 2),
        ),
    ]
    return {
        "famille": "puissances",
        "cle": "%s-%d" % (forme, a),
        "enonce": enonce,
        "regle": "racine carrée d'une puissance : l'exposant est divisé par 2, a^{1/2} = √a",
        "correct": correct,
        "faux": faux,
    }


# --------------------------------------------------------------------------- #
# famille : suites                                                             #
# --------------------------------------------------------------------------- #


def t_suite_un1_quadratique(rng):
    a = rng.choice([1, 2, 3, -1, -2])
    b = rng.choice([2, 3, 4, 5, -2, -3, -4, -5])
    c = rng.choice([-6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6])
    # aucune des quatre propositions ne doit perdre son terme constant :
    # une réponse plus courte que les autres se repère sans calculer
    if 0 in (a + b + c, a + c, b + c, c + 1):
        return None
    un = poly_latex([(a, 2), (b, 1), (c, 0)], "n")
    enonce = (
        "Soit $(u_n)$ définie pour tout $n$ entier naturel par $u_n = " + un + "$. "
        "Que vaut $u_{n+1}$ ?"
    )
    correct = poly_opt([(a, 2), (2 * a + b, 1), (a + b + c, 0)], "n")
    faux = [
        poly_opt([(a, 2), (2 * a + b, 1), (a + c, 0)], "n"),
        poly_opt([(a, 2), (b, 1), (b + c, 0)], "n"),
        poly_opt([(a, 2), (b, 1), (c + 1, 0)], "n"),
    ]
    return {
        "famille": "suites",
        "cle": "%d-%d-%d" % (a, b, c),
        "enonce": enonce,
        "regle": "u_{n+1} : on remplace n par n+1 PARTOUT, puis on développe",
        "correct": correct,
        "faux": faux,
    }


def t_suite_un1_quotient(rng):
    a = rng.randint(1, 7)
    b = rng.choice([0, 0, 1, 2, 3, 4, 5])
    if b == a:
        return None

    def hn(k):
        return "n" if k == 0 else "n+" + str(k)

    un = "\\dfrac{" + hn(b) + "}{" + hn(a) + "}"
    enonce = (
        "Soit $(u_n)$ définie pour tout $n$ entier naturel par $u_n = " + un + "$. "
        "Que vaut $u_{n+1}$ ?"
    )
    correct = (
        "$\\dfrac{" + hn(b + 1) + "}{" + hn(a + 1) + "}$",
        sn(lambda n: Fraction(n + b + 1, n + a + 1)),
    )
    faux = [
        ("$\\dfrac{" + hn(b + 1) + "}{" + hn(a) + "}$", sn(lambda n: Fraction(n + b + 1, n + a))),
        ("$\\dfrac{" + hn(b) + "}{" + hn(a + 1) + "}$", sn(lambda n: Fraction(n + b, n + a + 1))),
        ("$" + un + " + 1$", sn(lambda n: Fraction(n + b, n + a) + 1)),
    ]
    return {
        "famille": "suites",
        "cle": "%d-%d" % (a, b),
        "enonce": enonce,
        "regle": "u_{n+1} : n devient n+1 au numérateur ET au dénominateur",
        "correct": correct,
        "faux": faux,
    }


def t_suite_un1_geometrique(rng):
    k = rng.choice([2, 3, 4, 5, 6])
    b = rng.choice([2, 3, 4, 5])
    if k == b:
        return None
    enonce = (
        "Soit $(u_n)$ définie pour tout $n$ entier naturel par $u_n = " + str(k)
        + " \\times " + str(b) + "^{n}$. Que vaut $u_{n+1}$ ?"
    )
    correct = (
        "$" + str(k) + " \\times " + str(b) + "^{n+1}$",
        sn(lambda n: Fraction(k) * Fraction(b) ** (n + 1)),
    )
    faux = [
        (
            "$" + str(k) + " \\times " + str(b) + "^{n} + 1$",
            sn(lambda n: Fraction(k) * Fraction(b) ** n + 1),
        ),
        (
            "$" + str(k) + "^{n+1} \\times " + str(b) + "$",
            sn(lambda n: Fraction(k) ** (n + 1) * b),
        ),
        ("$" + str(k * b) + "^{n+1}$", sn(lambda n: Fraction(k * b) ** (n + 1))),
    ]
    return {
        "famille": "suites",
        "cle": "%d-%d" % (k, b),
        "enonce": enonce,
        "regle": "u_{n+1} : seul l'exposant passe à n+1, le coefficient ne bouge pas",
        "correct": correct,
        "faux": faux,
    }


def t_suite_difference(rng):
    a = rng.choice([1, 2, 3, -1, -2])
    b = rng.choice([1, 2, 3, 4, 5, -1, -2, -3, -4, -5])
    c = rng.choice([-5, -3, -1, 0, 1, 2, 4, 6])
    if a == 2 * b or a == b or a + b == 0:
        return None
    un = poly_latex([(a, 2), (b, 1), (c, 0)], "n")
    enonce = (
        "Soit $(u_n)$ définie pour tout $n$ entier naturel par $u_n = " + un + "$. "
        "Que vaut $u_{n+1} - u_n$ ?"
    )
    correct = poly_opt([(2 * a, 1), (a + b, 0)], "n")
    faux = [
        poly_opt([(2 * a, 1), (b, 0)], "n"),
        poly_opt([(a + b, 0)], "n"),
        poly_opt([(2 * a, 1), (a - b, 0)], "n"),
    ]
    return {
        "famille": "suites",
        "cle": "%d-%d-%d" % (a, b, c),
        "enonce": enonce,
        "regle": "u_{n+1} - u_n : on calcule u_{n+1} d'abord, puis on soustrait terme à terme",
        "correct": correct,
        "faux": faux,
    }


def t_suite_u2n(rng):
    a = rng.choice([2, 3, 4, 5, 6, 7, -2, -3, -4, -5])
    un = poly_latex([(1, 2), (a, 1)], "n")
    enonce = (
        "Soit $(u_n)$ définie pour tout $n$ entier naturel par $u_n = " + un + "$. "
        "Que vaut $u_{2n}$ ?"
    )
    correct = poly_opt([(4, 2), (2 * a, 1)], "n")
    faux = [
        poly_opt([(2, 2), (2 * a, 1)], "n"),
        poly_opt([(1, 2), (2 * a, 1)], "n"),
        poly_opt([(4, 2), (a, 1)], "n"),
    ]
    return {
        "famille": "suites",
        "cle": "%d" % a,
        "enonce": enonce,
        "regle": "u_{2n} : on remplace n par 2n, y compris dans le carré : (2n)^2 = 4n^2",
        "correct": correct,
        "faux": faux,
    }


def t_suite_recurrence(rng):
    p = rng.randint(0, 5)
    a = rng.choice([2, 3, -2])
    b = rng.choice([-3, -2, -1, 1, 2, 3, 4, 5])
    cible = rng.choice([3, 3, 4])
    u = [p]
    for _ in range(cible + 1):
        u.append(a * u[-1] + b)
    droite = (str(a) if a != 1 else "") + "u_n" + (" + " + str(b) if b > 0 else " - " + str(-b))
    enonce = (
        "Soit $(u_n)$ définie par $u_0 = " + str(p) + "$ et $u_{n+1} = " + droite
        + "$ pour tout $n$ entier naturel. Que vaut $u_{" + str(cible) + "}$ ?"
    )
    correct = frac_opt(u[cible])
    faux = [
        frac_opt(u[cible - 1]),
        frac_opt(u[cible + 1]),
        frac_opt(a ** cible * p + b),
    ]
    return {
        "famille": "suites",
        "cle": "%d-%d-%d-%d" % (p, a, b, cible),
        "enonce": enonce,
        "regle": "une récurrence se déroule pas à pas : u_1, puis u_2, puis u_3, sans formule",
        "correct": correct,
        "faux": faux,
    }


def t_suite_nature(rng):
    genre = rng.choice(["arith-explicite", "geo-explicite", "arith-recurrence", "geo-recurrence"])
    a = rng.choice([2, 3, 4, 5, 6, -2, -3])
    b = rng.choice([1, 2, 3, 5, 7, -1, -4])
    if a == b:
        return None
    explicite = genre.endswith("explicite")
    if genre == "arith-explicite":
        un = "u_n = " + poly_latex([(a, 1), (b, 0)], "n")
        raison, nature, autre = a, "arithmétique", b
    elif genre == "geo-explicite":
        if a < 2:
            return None
        un = "u_n = " + str(b) + " \\times " + str(a) + "^{n}"
        raison, nature, autre = a, "géométrique", b
    elif genre == "arith-recurrence":
        un = "u_0 = " + str(b) + "$ et $u_{n+1} = u_n + " + str(a) if a > 0 else (
            "u_0 = " + str(b) + "$ et $u_{n+1} = u_n - " + str(-a)
        )
        raison, nature, autre = a, "arithmétique", b
    else:
        if a < 2:
            return None
        un = "u_0 = " + str(b) + "$ et $u_{n+1} = " + str(a) + "u_n"
        raison, nature, autre = a, "géométrique", b
    enonce = (
        "Soit $(u_n)$ définie pour tout $n$ entier naturel par $" + un + "$. "
        "Quelle est sa nature ?"
    )
    if nature == "arithmétique":
        bonne = "arithmétique de raison $" + str(raison) + "$, car $u_{n+1} - u_n = " + str(raison) + "$"
        f1 = (
            "géométrique de raison $" + str(raison) + "$, car on retrouve $" + str(raison)
            + "$ d'un terme au suivant"
        )
        f2 = (
            "arithmétique de raison $" + str(autre) + "$, car "
            + ("le terme constant vaut $" if explicite else "le premier terme vaut $")
            + str(autre) + "$"
        )
    else:
        bonne = (
            "géométrique de raison $" + str(raison) + "$, car $\\dfrac{u_{n+1}}{u_n} = "
            + str(raison) + "$"
        )
        f1 = "arithmétique de raison $" + str(raison) + "$, car on multiplie toujours par $" + str(raison) + "$"
        f2 = (
            "géométrique de raison $" + str(autre) + "$, car "
            + ("le coefficient devant la puissance vaut $" if explicite else "le premier terme vaut $")
            + str(autre) + "$"
        )
    f3 = "ni arithmétique ni géométrique"
    return {
        "famille": "suites",
        "cle": "%s-%d-%d" % (genre, a, b),
        "enonce": enonce,
        "regle": "arithmétique si u_{n+1} - u_n est constant, géométrique si u_{n+1}/u_n est constant",
        "correct": mot(bonne, ("txt", bonne)),
        "faux": [mot(f1, ("txt", f1)), mot(f2, ("txt", f2)), mot(f3, ("txt", f3))],
    }


# --------------------------------------------------------------------------- #
# famille : signes et inégalités                                               #
# --------------------------------------------------------------------------- #

FLIP = {"\\leqslant": "\\geqslant", "\\geqslant": "\\leqslant", "<": ">", ">": "<"}


def t_signe_inequation_negative(rng):
    a = rng.randint(2, 9)
    b = rng.randint(-9, 9)
    c = rng.randint(-12, 12)
    rel = rng.choice(["\\leqslant", "<", "\\geqslant", ">"])
    r = Fraction(b - c, a)
    if r == 0:
        return None
    rel2 = FLIP[rel]
    gauche = poly_latex([(-a, 1), (b, 0)], "x")
    enonce = "Résoudre dans $\\mathbb{R}$ l'inéquation $" + gauche + " " + rel + " " + str(c) + "$."
    correct = ("$x " + rel2 + " " + num_latex(r) + "$", ("sol", rel2, r))
    faux = [
        ("$x " + rel + " " + num_latex(r) + "$", ("sol", rel, r)),
        ("$x " + rel2 + " " + num_latex(-r) + "$", ("sol", rel2, -r)),
        ("$x " + rel + " " + num_latex(-r) + "$", ("sol", rel, -r)),
    ]
    return {
        "famille": "signes-inegalites",
        "cle": "%d-%d-%d-%s" % (a, b, c, rel),
        "enonce": enonce,
        "regle": "on divise par un nombre négatif : l'inégalité change de sens",
        "correct": correct,
        "faux": faux,
    }


def ens_latex(s):
    if not s:
        return "aucun entier naturel"
    return "$n \\in \\{" + "\\,;\\,".join(str(k) for k in sorted(s)) + "\\}$"


def t_signe_trinome_entiers(rng):
    r1 = rng.randint(1, 6)
    ecart = rng.choice([1, 1, 2, 3])
    r2 = r1 + ecart
    s, p = r1 + r2, r1 * r2
    expr = poly_latex([(1, 2), (-s, 1), (p, 0)], "n")
    enonce = "Pour quels entiers naturels $n$ a-t-on $" + expr + " < 0$ ?"
    dedans = set(range(r1 + 1, r2))
    if not dedans:
        correct = mot("aucun entier naturel", ("ens", frozenset()))
        faux = [
            mot("$" + str(r1) + " < n < " + str(r2) + "$", ("intervalle", r1, r2)),
            mot(ens_latex({r1, r2}), ("ens", frozenset({r1, r2}))),
            mot("$n \\geqslant " + str(r2) + "$", ("seuil", r2)),
        ]
    else:
        correct = mot(ens_latex(dedans), ("ens", frozenset(dedans)))
        faux = [
            mot(ens_latex(dedans | {r1, r2}), ("ens", frozenset(dedans | {r1, r2}))),
            mot(ens_latex(dedans | {r2}), ("ens", frozenset(dedans | {r2}))),
            mot("aucun entier naturel", ("ens", frozenset())),
        ]
    return {
        "famille": "signes-inegalites",
        "cle": "%d-%d" % (r1, r2),
        "enonce": enonce,
        "regle": "un trinôme est négatif strictement entre ses racines ; sur N on ne garde que les entiers de cet intervalle",
        "correct": correct,
        "faux": faux,
    }


def t_signe_affine_en_n(rng):
    a = rng.randint(2, 9)
    b = rng.randint(5, 60)
    k = b // a + 1
    if k < 2:
        return None
    expr = poly_latex([(a, 1), (-b, 0)], "n")
    enonce = (
        "À partir de quel entier naturel $n$ l'expression $" + expr
        + "$ est-elle strictement positive ?"
    )
    correct = mot("$n \\geqslant " + str(k) + "$", ("seuil", k))
    faux = [
        mot("$n \\geqslant " + str(k - 1) + "$", ("seuil", k - 1)),
        mot("$n \\geqslant " + str(k + 1) + "$", ("seuil", k + 1)),
        mot("pour tout entier naturel $n$", ("tous",)),
    ]
    return {
        "famille": "signes-inegalites",
        "cle": "%d-%d" % (a, b),
        "enonce": enonce,
        "regle": "an - b > 0 équivaut à n > b/a : on prend le premier entier strictement au-dessus",
        "correct": correct,
        "faux": faux,
    }


def t_signe_produit(rng):
    a = rng.randint(2, 9)
    b = rng.randint(1, a - 1)
    enonce = (
        "Pour quelles valeurs de $x$ le produit $(x - " + str(a) + ")(x + " + str(b) + ")$ "
        "est-il strictement négatif ?"
    )
    correct = mot("$-" + str(b) + " < x < " + str(a) + "$", ("int", -b, a))
    faux = [
        mot("$x < -" + str(b) + "$ ou $x > " + str(a) + "$", ("hors", -b, a)),
        mot("$-" + str(a) + " < x < " + str(b) + "$", ("int", -a, b)),
        mot("$" + str(b) + " < x < " + str(a) + "$", ("int", b, a)),
    ]
    return {
        "famille": "signes-inegalites",
        "cle": "%d-%d" % (a, b),
        "enonce": enonce,
        "regle": "un produit est négatif quand les deux facteurs sont de signes contraires : entre les racines",
        "correct": correct,
        "faux": faux,
    }


def t_signe_quotient(rng):
    a = rng.randint(2, 9)
    b = rng.randint(2, 9)
    enonce = (
        "Résoudre $\\dfrac{x - " + str(a) + "}{x + " + str(b) + "} \\leqslant 0$."
    )
    correct = mot("$-" + str(b) + " < x \\leqslant " + str(a) + "$", ("oc", -b, a))
    faux = [
        mot("$-" + str(b) + " \\leqslant x \\leqslant " + str(a) + "$", ("cc", -b, a)),
        mot("$-" + str(b) + " < x < " + str(a) + "$", ("oo", -b, a)),
        mot("$x \\leqslant -" + str(b) + "$ ou $x \\geqslant " + str(a) + "$", ("hors", -b, a)),
    ]
    return {
        "famille": "signes-inegalites",
        "cle": "%d-%d" % (a, b),
        "enonce": enonce,
        "regle": "le quotient s'annule au zéro du numérateur et n'existe pas au zéro du dénominateur",
        "correct": correct,
        "faux": faux,
    }


def t_signe_expression_en_n(rng):
    genre = rng.choice(["quotient-neg", "quotient-pos", "carre-neg", "inverse-pos"])
    a = rng.randint(1, 9)
    b = rng.randint(1, 9)
    if genre == "quotient-neg":
        expr = "\\dfrac{-n - " + str(a) + "}{n + " + str(b) + "}"
        signe = "négatif"
    elif genre == "quotient-pos":
        expr = "\\dfrac{n + " + str(a) + "}{n + " + str(b) + "}"
        signe = "positif"
    elif genre == "carre-neg":
        expr = "-(n + " + str(a) + ")^{2}"
        signe = "négatif"
    else:
        expr = "\\dfrac{" + str(a) + "}{(n + " + str(b) + ")^{2}}"
        signe = "positif"
    enonce = "Quel est le signe de $" + expr + "$ pour tout $n$ entier naturel ?"
    bonne = "strictement " + signe + " pour tout $n$"
    autre = "strictement " + ("positif" if signe == "négatif" else "négatif") + " pour tout $n$"
    return {
        "famille": "signes-inegalites",
        "cle": "%s-%d-%d" % (genre, a, b),
        "enonce": enonce,
        "regle": "pour n entier naturel, n + a est toujours strictement positif : seul le signe écrit devant compte",
        "correct": mot(bonne, ("txt", bonne)),
        "faux": [
            mot(autre, ("txt", autre)),
            mot("négatif puis positif à partir d'un certain rang", ("txt", "np")),
            mot("positif puis négatif à partir d'un certain rang", ("txt", "pn")),
        ],
    }


# --------------------------------------------------------------------------- #
# famille : développement et factorisation                                     #
# --------------------------------------------------------------------------- #


def t_dev_carre(rng):
    a = rng.randint(2, 5)
    b = rng.randint(1, 9)
    s = rng.choice([1, -1])
    v = rng.choice(["x", "n"])
    gauche = "\\left(" + poly_latex([(a, 1), (s * b, 0)], v) + "\\right)^{2}"
    enonce = "Développer $" + gauche + "$."
    correct = poly_opt([(a * a, 2), (2 * a * b * s, 1), (b * b, 0)], v)
    faux = [
        poly_opt([(a * a, 2), (b * b, 0)], v),
        poly_opt([(a * a, 2), (a * b * s, 1), (b * b, 0)], v),
        poly_opt([(a, 2), (2 * a * b * s, 1), (b * b, 0)], v),
    ]
    return {
        "famille": "developpement-factorisation",
        "cle": "%d-%d-%d-%s" % (a, b, s, v),
        "enonce": enonce,
        "regle": "(a ± b)^2 = a^2 ± 2ab + b^2 : le double produit ne disparaît jamais",
        "correct": correct,
        "faux": faux,
    }


def t_dev_difference_carres(rng):
    a = rng.randint(2, 6)
    b = rng.randint(1, 9)
    v = rng.choice(["x", "n"])
    gauche = (
        "\\left(" + poly_latex([(a, 1), (b, 0)], v) + "\\right)\\left("
        + poly_latex([(a, 1), (-b, 0)], v) + "\\right)"
    )
    enonce = "Développer $" + gauche + "$."
    correct = poly_opt([(a * a, 2), (-b * b, 0)], v)
    faux = [
        poly_opt([(a * a, 2), (b * b, 0)], v),
        poly_opt([(a * a, 2), (-2 * a * b, 1), (b * b, 0)], v),
        poly_opt([(a, 2), (-b * b, 0)], v),
    ]
    return {
        "famille": "developpement-factorisation",
        "cle": "%d-%d-%s" % (a, b, v),
        "enonce": enonce,
        "regle": "(a - b)(a + b) = a^2 - b^2 : les termes du milieu se compensent",
        "correct": correct,
        "faux": faux,
    }


def t_fact_difference_carres(rng):
    p = rng.randint(2, 9)
    q = rng.randint(1, 9)
    v = rng.choice(["x", "n"])
    ordre = rng.choice(["A-B", "B-A"])
    if gcd(p, q) != 1:
        return None  # sinon il resterait un facteur numérique à sortir
    A, B = p * p, q * q
    qv = poly_latex([(q, 1)], v)
    pv = str(p)

    def prod(u, w):
        return "\\left(" + u + "\\right)\\left(" + w + "\\right)"

    def carre(u):
        return "\\left(" + u + "\\right)^{2}"

    if ordre == "A-B":
        # 16 - 81x^2, comme Hassan l'a vu passer : la constante devant
        expr = poly_latex([(A, 0)], v) + " - " + poly_latex([(B, 2)], v)
        correct = (
            "$" + prod(pv + " - " + qv, pv + " + " + qv) + "$",
            sx(lambda x: Fraction(A) - Fraction(B) * x * x),
        )
        f1 = ("$" + carre(pv + " - " + qv) + "$", sx(lambda x: (Fraction(p) - Fraction(q) * x) ** 2))
        f2 = (
            "$" + prod(qv + " - " + pv, qv + " + " + pv) + "$",
            sx(lambda x: Fraction(B) * x * x - Fraction(A)),
        )
        if q >= 2:
            bv = poly_latex([(B, 1)], v)
            f3 = (
                "$" + prod(pv + " - " + bv, pv + " + " + bv) + "$",
                sx(lambda x: Fraction(A) - Fraction(B * B) * x * x),
            )
        else:
            f3 = ("$" + carre(pv + " + " + qv) + "$", sx(lambda x: (Fraction(p) + Fraction(q) * x) ** 2))
    else:
        expr = poly_latex([(B, 2), (-A, 0)], v)
        correct = (
            "$" + prod(qv + " - " + pv, qv + " + " + pv) + "$",
            sx(lambda x: Fraction(B) * x * x - Fraction(A)),
        )
        f1 = ("$" + carre(qv + " - " + pv) + "$", sx(lambda x: (Fraction(q) * x - Fraction(p)) ** 2))
        f2 = (
            "$" + prod(pv + " - " + qv, pv + " + " + qv) + "$",
            sx(lambda x: Fraction(A) - Fraction(B) * x * x),
        )
        f3 = ("$" + carre(qv + " + " + pv) + "$", sx(lambda x: (Fraction(q) * x + Fraction(p)) ** 2))
    enonce = "Factoriser $" + expr + "$."
    return {
        "famille": "developpement-factorisation",
        "cle": "%s-%d-%d-%s" % (ordre, p, q, v),
        "enonce": enonce,
        "regle": "a^2 - b^2 = (a-b)(a+b) ; encore faut-il voir 16 comme 4^2 et 81x^2 comme (9x)^2",
        "correct": correct,
        "faux": [f1, f2, f3],
    }


def t_fact_facteur_commun(rng):
    v = rng.choice(["x", "n"])
    a = rng.randint(1, 9)
    b = rng.randint(1, 9)
    c = rng.randint(1, 9)
    forme = rng.choice(["deux-produits", "carre-plus-produit"])

    def par(t):
        return "\\left(" + t + "\\right)"

    va = poly_latex([(1, 1), (a, 0)], v)
    if forme == "deux-produits":
        # trois constantes distinctes (sinon (x+7)(x+7) s'écrit au carré) et
        # b+c impair, pour que la factorisation soit complète : pas de 2 à sortir
        if len({a, b, c}) != 3 or (b + c) % 2 == 0:
            return None
        vb = poly_latex([(1, 1), (b, 0)], v)
        vc = poly_latex([(1, 1), (c, 0)], v)
        expr = par(va) + par(vb) + " + " + par(va) + par(vc)
        correct = (
            "$" + par(va) + par(poly_latex([(2, 1), (b + c, 0)], v)) + "$",
            sx(lambda x: (x + a) * (2 * x + b + c)),
        )
        faux = [
            (
                "$" + par(va) + par(poly_latex([(1, 1), (b + c, 0)], v)) + "$",
                sx(lambda x: (x + a) * (x + b + c)),
            ),
            (
                "$" + par(poly_latex([(2, 1), (2 * a, 0)], v)) + par(poly_latex([(1, 1), (b + c, 0)], v)) + "$",
                sx(lambda x: (2 * x + 2 * a) * (x + b + c)),
            ),
            (
                "$" + par(va) + par(vb) + par(vc) + "$",
                sx(lambda x: (x + a) * (x + b) * (x + c)),
            ),
        ]
    else:
        expr = par(va) + "^{2} + " + ("" if b == 1 else str(b)) + par(va)
        correct = (
            "$" + par(va) + par(poly_latex([(1, 1), (a + b, 0)], v)) + "$",
            sx(lambda x: (x + a) * (x + a + b)),
        )
        faux = [
            (
                "$" + par(va) + par(poly_latex([(1, 1), (b, 0)], v)) + "$",
                sx(lambda x: (x + a) * (x + b)),
            ),
            (
                "$" + par(va) + par(poly_latex([(2, 1), (a + b, 0)], v)) + "$",
                sx(lambda x: (x + a) * (2 * x + a + b)),
            ),
            (
                "$" + par(poly_latex([(1, 1), (a + b, 0)], v)) + "^{2}$",
                sx(lambda x: (x + a + b) ** 2),
            ),
        ]
    enonce = "Factoriser $" + expr + "$."
    return {
        "famille": "developpement-factorisation",
        "cle": "%s-%d-%d-%d-%s" % (forme, a, b, c, v),
        "enonce": enonce,
        "regle": "facteur commun : on met le facteur en facteur et on additionne ce qui reste",
        "correct": correct,
        "faux": faux,
    }


def t_fact_carre_parfait(rng):
    a = rng.randint(2, 6)
    b = rng.randint(1, 9)
    s = rng.choice([1, -1])
    v = rng.choice(["x", "n"])
    if gcd(a, b) != 1:
        return None  # sinon il resterait un facteur numérique à sortir
    expr = poly_latex([(a * a, 2), (2 * a * b * s, 1), (b * b, 0)], v)
    enonce = "Factoriser $" + expr + "$."

    def carre(t):
        return "\\left(" + t + "\\right)^{2}"

    correct = (
        "$" + carre(poly_latex([(a, 1), (s * b, 0)], v)) + "$",
        sx(lambda x: (Fraction(a) * x + s * b) ** 2),
    )
    faux = [
        (
            "$" + carre(poly_latex([(a, 1), (-s * b, 0)], v)) + "$",
            sx(lambda x: (Fraction(a) * x - s * b) ** 2),
        ),
        (
            "$\\left(" + poly_latex([(a, 1), (s * b, 0)], v) + "\\right)\\left("
            + poly_latex([(a, 1), (-s * b, 0)], v) + "\\right)$",
            sx(lambda x: (Fraction(a) * x + s * b) * (Fraction(a) * x - s * b)),
        ),
        (
            "$" + carre(poly_latex([(a * a, 1), (s * b * b, 0)], v)) + "$",
            sx(lambda x: (Fraction(a * a) * x + s * b * b) ** 2),
        ),
    ]
    return {
        "famille": "developpement-factorisation",
        "cle": "%d-%d-%d-%s" % (a, b, s, v),
        "enonce": enonce,
        "regle": "a^2 + 2ab + b^2 = (a+b)^2 : on vérifie que le terme du milieu vaut bien 2ab",
        "correct": correct,
        "faux": faux,
    }


def t_dev_produit_general(rng):
    a = rng.randint(1, 5)
    c = rng.randint(1, 5)
    b = rng.choice([-9, -7, -5, -4, -3, -2, 2, 3, 4, 5, 6, 7])
    d = rng.choice([-9, -7, -5, -4, -3, -2, 2, 3, 4, 5, 6, 7])
    v = rng.choice(["x", "n"])
    gauche = (
        "\\left(" + poly_latex([(a, 1), (b, 0)], v) + "\\right)\\left("
        + poly_latex([(c, 1), (d, 0)], v) + "\\right)"
    )
    enonce = "Développer $" + gauche + "$."
    correct = poly_opt([(a * c, 2), (a * d + b * c, 1), (b * d, 0)], v)
    faux = [
        poly_opt([(a * c, 2), (b * d, 0)], v),
        poly_opt([(a * c, 2), (a * c + b * d, 1), (b * d, 0)], v),
        poly_opt([(a * c, 2), (a * d - b * c, 1), (b * d, 0)], v),
    ]
    return {
        "famille": "developpement-factorisation",
        "cle": "%d-%d-%d-%d-%s" % (a, b, c, d, v),
        "enonce": enonce,
        "regle": "double distributivité : quatre produits, (ax+b)(cx+d) = acx^2 + (ad+bc)x + bd",
        "correct": correct,
        "faux": faux,
    }


# --------------------------------------------------------------------------- #
# famille : fractions                                                          #
# --------------------------------------------------------------------------- #


def t_frac_somme(rng):
    b = rng.randint(2, 12)
    d = rng.randint(2, 12)
    if b == d:
        return None
    a = rng.randint(1, 9)
    c = rng.randint(1, 9)
    if gcd(a, b) != 1 or gcd(c, d) != 1:
        return None
    enonce = (
        "Calculer $\\dfrac{" + str(a) + "}{" + str(b) + "} + \\dfrac{" + str(c) + "}{" + str(d) + "}$."
    )
    correct = frac_opt(Fraction(a, b) + Fraction(c, d))
    faux = [
        frac_opt(Fraction(a + c, b + d)),
        frac_opt(Fraction(a + c, b * d)),
        frac_opt(Fraction(a * d + b * c, b + d)),
    ]
    return {
        "famille": "fractions",
        "cle": "%d-%d-%d-%d" % (a, b, c, d),
        "enonce": enonce,
        "regle": "même dénominateur avant d'additionner ; on n'additionne jamais les dénominateurs",
        "correct": correct,
        "faux": faux,
    }


def t_frac_quotient(rng):
    a = rng.randint(1, 9)
    b = rng.randint(2, 9)
    c = rng.randint(1, 9)
    d = rng.randint(2, 9)
    if gcd(a, b) != 1 or gcd(c, d) != 1:
        return None
    enonce = (
        "Calculer $\\dfrac{" + str(a) + "}{" + str(b) + "} \\div \\dfrac{" + str(c) + "}{"
        + str(d) + "}$."
    )
    correct = frac_opt(Fraction(a * d, b * c))
    faux = [
        frac_opt(Fraction(a * c, b * d)),
        frac_opt(Fraction(b * c, a * d)),
        frac_opt(Fraction(b * d, a * c)),
    ]
    return {
        "famille": "fractions",
        "cle": "%d-%d-%d-%d" % (a, b, c, d),
        "enonce": enonce,
        "regle": "diviser par une fraction, c'est multiplier par son inverse",
        "correct": correct,
        "faux": faux,
    }


def t_frac_simplifier(rng):
    c = rng.choice([2, 3, 4, 5, 6])
    a = c * rng.randint(2, 7)
    b = c * rng.choice([-6, -5, -4, -3, -2, 2, 3, 4, 5, 6, 7, 8])
    haut = poly_latex([(a, 1), (b, 0)], "n")
    enonce = "Simplifier $\\dfrac{" + haut + "}{" + str(c) + "}$."
    correct = poly_opt([(a // c, 1), (b // c, 0)], "n")
    faux = [
        poly_opt([(a, 1), (b // c, 0)], "n"),
        poly_opt([(a // c, 1), (b, 0)], "n"),
        (
            "$\\dfrac{" + poly_latex([(a // c, 1), (b // c, 0)], "n") + "}{" + str(c) + "}$",
            ("poly2", ("div", c, a // c, b // c)),
        ),
    ]
    return {
        "famille": "fractions",
        "cle": "%d-%d-%d" % (a, b, c),
        "enonce": enonce,
        "regle": "on divise CHAQUE terme du numérateur : (6n+9)/3 = 2n + 3",
        "correct": correct,
        "faux": faux,
    }


def t_frac_imbriquee(rng):
    a = rng.randint(2, 9)
    b = rng.randint(2, 9)
    c = rng.randint(2, 9)
    if gcd(b, c) != 1:
        return None
    enonce = (
        "Simplifier $\\dfrac{" + str(a) + "}{\\dfrac{" + str(b) + "}{" + str(c) + "}}$."
    )
    correct = frac_opt(Fraction(a * c, b))
    faux = [
        frac_opt(Fraction(a * b, c)),
        frac_opt(Fraction(b, a * c)),
        frac_opt(Fraction(c, a * b)),
    ]
    return {
        "famille": "fractions",
        "cle": "%d-%d-%d" % (a, b, c),
        "enonce": enonce,
        "regle": "une fraction au dénominateur : on multiplie par son inverse",
        "correct": correct,
        "faux": faux,
    }


def t_frac_litterale(rng):
    a = rng.randint(1, 6)
    signe = rng.choice(["+", "-"])
    if signe == "-" and a < 2:
        return None
    na = "n + " + str(a)
    prod = "n(n + " + str(a) + ")"
    enonce = (
        "Écrire $\\dfrac{1}{n} " + signe + " \\dfrac{1}{" + na + "}$ sous la forme d'une seule "
        "fraction, pour $n$ entier naturel non nul."
    )
    if signe == "+":
        correct = (
            "$\\dfrac{" + poly_latex([(2, 1), (a, 0)], "n") + "}{" + prod + "}$",
            sn(lambda n: Fraction(2 * n + a, n * (n + a))),
        )
        faux = [
            ("$\\dfrac{2}{" + poly_latex([(2, 1), (a, 0)], "n") + "}$", sn(lambda n: Fraction(2, 2 * n + a))),
            ("$\\dfrac{1}{" + poly_latex([(2, 1), (a, 0)], "n") + "}$", sn(lambda n: Fraction(1, 2 * n + a))),
            ("$\\dfrac{1}{" + prod + "}$", sn(lambda n: Fraction(1, n * (n + a)))),
        ]
    else:
        correct = (
            "$\\dfrac{" + str(a) + "}{" + prod + "}$",
            sn(lambda n: Fraction(a, n * (n + a))),
        )
        faux = [
            ("$\\dfrac{-" + str(a) + "}{" + prod + "}$", sn(lambda n: Fraction(-a, n * (n + a)))),
            (
                "$\\dfrac{" + str(a) + "}{" + poly_latex([(2, 1), (a, 0)], "n") + "}$",
                sn(lambda n: Fraction(a, 2 * n + a)),
            ),
            ("$\\dfrac{1}{" + prod + "}$", sn(lambda n: Fraction(1, n * (n + a)))),
        ]
    return {
        "famille": "fractions",
        "cle": "%s-%d" % (signe, a),
        "enonce": enonce,
        "regle": "dénominateur commun n(n+a) ; on n'additionne jamais les dénominateurs entre eux",
        "correct": correct,
        "faux": faux,
    }


def t_frac_difference(rng):
    b = rng.randint(2, 12)
    d = rng.randint(2, 12)
    if b == d:
        return None
    a = rng.randint(1, 9)
    c = rng.randint(1, 9)
    if gcd(a, b) != 1 or gcd(c, d) != 1:
        return None
    enonce = (
        "Calculer $\\dfrac{" + str(a) + "}{" + str(b) + "} - \\dfrac{" + str(c) + "}{" + str(d) + "}$."
    )
    correct = frac_opt(Fraction(a, b) - Fraction(c, d))
    faux = [
        frac_opt(Fraction(a - c, b - d)),
        frac_opt(Fraction(a - c, b * d)),
        frac_opt(Fraction(a * d + b * c, b * d)),
    ]
    return {
        "famille": "fractions",
        "cle": "%d-%d-%d-%d" % (a, b, c, d),
        "enonce": enonce,
        "regle": "soustraire deux fractions : même dénominateur, et le signe porte sur tout le numérateur",
        "correct": correct,
        "faux": faux,
    }


# --------------------------------------------------------------------------- #
# le registre                                                                  #
# --------------------------------------------------------------------------- #

GABARITS = {
    "puissances": [
        ("puiss-meme-base", t_puiss_meme_base),
        ("puiss-bases-quotient", t_puiss_bases_quotient),
        ("puiss-bases-produit", t_puiss_bases_produit),
        ("puiss-somme", t_puiss_somme),
        ("puiss-parite", t_puiss_parite),
        ("puiss-exposant-negatif", t_puiss_exposant_negatif),
        ("puiss-puissance-de-puissance", t_puiss_puissance_de_puissance),
        ("puiss-exposant-fractionnaire", t_puiss_exposant_fractionnaire),
    ],
    "suites": [
        ("suite-un1-quadratique", t_suite_un1_quadratique),
        ("suite-un1-quotient", t_suite_un1_quotient),
        ("suite-un1-geometrique", t_suite_un1_geometrique),
        ("suite-difference", t_suite_difference),
        ("suite-u2n", t_suite_u2n),
        ("suite-recurrence", t_suite_recurrence),
        ("suite-nature", t_suite_nature),
    ],
    "signes-inegalites": [
        ("signe-inequation-negative", t_signe_inequation_negative),
        ("signe-trinome-entiers", t_signe_trinome_entiers),
        ("signe-affine-en-n", t_signe_affine_en_n),
        ("signe-produit", t_signe_produit),
        ("signe-quotient", t_signe_quotient),
        ("signe-expression-en-n", t_signe_expression_en_n),
    ],
    "developpement-factorisation": [
        ("dev-carre", t_dev_carre),
        ("dev-difference-carres", t_dev_difference_carres),
        ("fact-difference-carres", t_fact_difference_carres),
        ("fact-facteur-commun", t_fact_facteur_commun),
        ("fact-carre-parfait", t_fact_carre_parfait),
        ("dev-produit-general", t_dev_produit_general),
    ],
    "fractions": [
        ("frac-somme", t_frac_somme),
        ("frac-quotient", t_frac_quotient),
        ("frac-simplifier", t_frac_simplifier),
        ("frac-imbriquee", t_frac_imbriquee),
        ("frac-litterale", t_frac_litterale),
        ("frac-difference", t_frac_difference),
    ],
}


# --------------------------------------------------------------------------- #
# fabrication d'une série                                                      #
# --------------------------------------------------------------------------- #


def propositions_saines(spec):
    """Quatre propositions distinctes : par leur valeur ET par leur écriture."""
    opts = [spec["correct"]] + list(spec["faux"])
    if len(opts) != 4:
        return False
    cles = [o[1] for o in opts]
    textes = [o[0] for o in opts]
    if len(set(map(repr, cles))) != 4:
        return False
    if len(set(textes)) != 4:
        return False
    for t in textes:
        if not t or "\n" in t or t.count("$") % 2:
            return False
    if spec["enonce"].count("$") % 2:
        return False
    return True


def repartir(poids, total):
    """Ramène les poids à un total exact, plus forts restes d'abord."""
    somme = sum(poids.values())
    if somme == total:
        return dict(poids)
    brut = {k: v * total / somme for k, v in poids.items()}
    part = {k: int(v) for k, v in brut.items()}
    reste = total - sum(part.values())
    ordre = sorted(poids, key=lambda k: (-(brut[k] - part[k]), k))
    for k in ordre[:reste]:
        part[k] += 1
    return part


def entrelacer(par_famille, rng):
    """Les familles se mélangent : jamais trois questions de suite de la même."""
    marques = []
    for fam, qs in par_famille.items():
        k = len(qs)
        for i, q in enumerate(qs):
            score = (i + 0.5 + rng.uniform(-0.35, 0.35)) / max(k, 1)
            marques.append((score, fam, q))
    marques.sort(key=lambda m: (m[0], m[1]))
    suite = [m[2] for m in marques]
    for i in range(len(suite) - 2):
        if suite[i]["famille"] == suite[i + 1]["famille"] == suite[i + 2]["famille"]:
            for j in range(i + 3, len(suite)):
                if suite[j]["famille"] != suite[i]["famille"]:
                    suite[i + 2], suite[j] = suite[j], suite[i + 2]
                    break
    return suite


def fabriquer(count, poids, seed):
    rng = random.Random(seed)
    part = repartir(poids, count)
    vues = set()
    par_famille = {}
    for fam in poids:
        k = part[fam]
        if k == 0:
            continue
        gabarits = GABARITS[fam]
        pool = []
        while len(pool) < k:
            bloc = list(gabarits)
            rng.shuffle(bloc)
            pool.extend(bloc)
        pool = pool[:k]
        questions = []
        for tid, fn in pool:
            for _ in range(600):
                spec = fn(rng)
                if spec is None:
                    continue
                cle = tid + "|" + spec["cle"]
                if cle in vues:
                    continue
                if not propositions_saines(spec):
                    continue
                vues.add(cle)
                spec["gabarit"] = tid
                questions.append(spec)
                break
            else:
                raise SystemExit(
                    "le gabarit %s n'a pas produit de question neuve en 600 essais" % tid
                )
        par_famille[fam] = questions
    suite = entrelacer(par_famille, rng)

    # la bonne lettre est uniforme sur la série
    places = [i % 4 for i in range(len(suite))]
    rng.shuffle(places)
    for spec, place in zip(suite, places):
        faux = list(spec["faux"])
        rng.shuffle(faux)
        opts = faux[:place] + [spec["correct"]] + faux[place:]
        spec["options"] = [o[0] for o in opts]
        spec["reponse"] = LETTRES[place]
    return suite


def rendre(numero, date, duree, questions):
    familles = []
    for q in questions:
        if q["famille"] not in familles:
            familles.append(q["famille"])
    out = []
    out.append("# Série " + str(numero))
    out.append("")
    out.append("date: " + date)
    out.append("duree: " + str(duree))
    out.append("familles: " + ", ".join(familles))
    for i, q in enumerate(questions, 1):
        out.append("")
        out.append("## " + str(i) + " · " + q["famille"])
        out.append("")
        out.append(q["enonce"])
        out.append("")
        for lettre, opt in zip(LETTRES, q["options"]):
            out.append("- " + lettre + ". " + opt)
        out.append("")
        out.append("<!-- reponse: " + q["reponse"] + " -->")
        regle = q["regle"].replace("-->", "->").replace("\n", " ").strip()
        out.append("<!-- regle: " + regle + " -->")
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- #
# le validateur : la grammaire de FORMAT-drills.md, à la ligne près            #
# --------------------------------------------------------------------------- #

RE_TITRE = re.compile(r"^# Série (\d+)$")
RE_ENTETE = re.compile(r"^([a-z]+): (.+)$")
RE_QUESTION = re.compile(r"^## (\d+) · ([a-z0-9]+(?:-[a-z0-9]+)*)$")
RE_OPTION = re.compile(r"^- ([A-D])\. (.+)$")
RE_REPONSE = re.compile(r"^<!-- reponse: ([A-D]) -->$")
RE_REGLE = re.compile(r"^<!-- regle: (.*) -->$")
RE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def verifier(chemin):
    """Renvoie (erreurs, resume). Une erreur est (ligne, message)."""
    err = []
    brut = Path(chemin).read_bytes()
    if brut.startswith(b"\xef\xbb\xbf"):
        err.append((1, "BOM interdit"))
        brut = brut[3:]
    if b"\r" in brut:
        err.append((1, "retour chariot CR : les fins de ligne doivent être LF"))
        brut = brut.replace(b"\r\n", b"\n")  # on continue la lecture sur le reste
    try:
        texte = brut.decode("utf-8")
    except UnicodeDecodeError as e:
        return [(1, "le fichier n'est pas de l'UTF-8 valide : %s" % e)], None
    if not texte.endswith("\n"):
        err.append((texte.count("\n") + 1, "il manque le saut de ligne final"))
    if texte.endswith("\n\n"):
        err.append((texte.count("\n"), "ligne vide en fin de fichier"))
    lignes = texte.split("\n")
    if lignes and lignes[-1] == "":
        lignes.pop()

    for i, l in enumerate(lignes, 1):
        if l != l.rstrip():
            err.append((i, "espace en fin de ligne"))
        if l.count("$") % 2:
            err.append((i, "délimiteurs $ impairs sur la ligne"))
    for i in range(len(lignes) - 1):
        if lignes[i] == "" and lignes[i + 1] == "":
            err.append((i + 2, "deux lignes vides de suite"))

    if not lignes:
        return [(1, "fichier vide")], None
    m = RE_TITRE.match(lignes[0])
    if not m:
        err.append((1, "la ligne 1 doit être « # Série N »"))
        numero = None
    else:
        numero = int(m.group(1))
    if len(lignes) < 2 or lignes[1] != "":
        err.append((2, "la ligne 2 doit être vide"))

    i = 2
    entete = {}
    while i < len(lignes) and lignes[i] != "" and not lignes[i].startswith("## "):
        m = RE_ENTETE.match(lignes[i])
        if not m:
            err.append((i + 1, "ligne d'en-tête attendue sous la forme « clé: valeur »"))
        else:
            cle, val = m.group(1), m.group(2)
            if cle in entete:
                err.append((i + 1, "clé d'en-tête « %s » en double" % cle))
            if cle not in ("date", "duree", "familles"):
                err.append((i + 1, "clé d'en-tête inconnue : « %s »" % cle))
            entete[cle] = (val, i + 1)
        i += 1
    for cle in ("date", "duree", "familles"):
        if cle not in entete:
            err.append((3, "clé d'en-tête obligatoire manquante : « %s »" % cle))
    if "date" in entete and not RE_DATE.match(entete["date"][0]):
        err.append((entete["date"][1], "date attendue au format AAAA-MM-JJ"))
    if "duree" in entete and not entete["duree"][0].isdigit():
        err.append((entete["duree"][1], "duree attendue en minutes, un entier"))
    familles_entete = []
    if "familles" in entete:
        familles_entete = [f.strip() for f in entete["familles"][0].split(",")]
        for f in familles_entete:
            if not re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", f):
                err.append((entete["familles"][1], "slug de famille invalide : « %s »" % f))

    if i < len(lignes) and lignes[i] != "":
        err.append((i + 1, "une ligne vide doit séparer l'en-tête de la première question"))
    else:
        i += 1

    attendu = 1
    familles_vues = []
    questions = 0
    while i < len(lignes):
        m = RE_QUESTION.match(lignes[i])
        if not m:
            err.append((i + 1, "titre de question attendu : « ## N · famille »"))
            i += 1
            continue
        ligne_q = i + 1
        n, fam = int(m.group(1)), m.group(2)
        if n != attendu:
            err.append((ligne_q, "numéro de question %d, attendu %d" % (n, attendu)))
        attendu = n + 1
        questions += 1
        if fam not in familles_vues:
            familles_vues.append(fam)
        i += 1
        if i >= len(lignes) or lignes[i] != "":
            err.append((i + 1, "une ligne vide doit suivre le titre de la question"))
        else:
            i += 1
        debut = i
        while i < len(lignes) and not RE_OPTION.match(lignes[i]) and not lignes[i].startswith("## "):
            i += 1
        corps = [l for l in lignes[debut:i] if l.strip()]
        if not corps:
            err.append((ligne_q, "énoncé vide"))
        if i > debut and lignes[i - 1] != "":
            err.append((i, "une ligne vide doit séparer l'énoncé des propositions"))
        vues = []
        for k, lettre in enumerate(LETTRES):
            if i >= len(lignes):
                err.append((i, "proposition %s manquante" % lettre))
                break
            mo = RE_OPTION.match(lignes[i])
            if not mo:
                err.append((i + 1, "proposition « - %s. … » attendue" % lettre))
                break
            if mo.group(1) != lettre:
                err.append((i + 1, "proposition %s attendue, trouvé %s" % (lettre, mo.group(1))))
            vues.append((mo.group(2), i + 1))
            i += 1
        if len(vues) == 4:
            for k in range(4):
                for j in range(k + 1, 4):
                    if vues[k][0] == vues[j][0]:
                        err.append((vues[j][1], "proposition identique à la proposition %s" % LETTRES[k]))
        if i < len(lignes) and RE_OPTION.match(lignes[i]):
            err.append((i + 1, "cinquième proposition : il en faut exactement quatre"))
        if i < len(lignes) and lignes[i] == "":
            i += 1
        else:
            err.append((i + 1, "une ligne vide doit séparer les propositions de la réponse"))
        if i < len(lignes) and RE_REPONSE.match(lignes[i]):
            i += 1
        else:
            err.append((i + 1, "commentaire « <!-- reponse: X --> » attendu"))
        if i < len(lignes) and lignes[i].startswith("<!-- regle:"):
            if not RE_REGLE.match(lignes[i]):
                err.append((i + 1, "commentaire regle mal formé (une seule ligne, finie par -->)"))
            i += 1
        if i < len(lignes):
            if lignes[i] != "":
                err.append((i + 1, "une ligne vide doit séparer deux questions"))
            else:
                i += 1

    if questions == 0:
        err.append((1, "aucune question"))
    if familles_entete and familles_entete != familles_vues:
        err.append(
            (
                entete["familles"][1],
                "l'en-tête familles (%s) ne suit pas l'ordre d'apparition (%s)"
                % (", ".join(familles_entete), ", ".join(familles_vues)),
            )
        )
    err.sort(key=lambda e: e[0])
    resume = {
        "numero": numero,
        "questions": questions,
        "familles": familles_vues,
        "date": entete.get("date", ("?",))[0],
        "duree": entete.get("duree", ("?",))[0],
    }
    return err, resume


# --------------------------------------------------------------------------- #
# la ligne de commande                                                         #
# --------------------------------------------------------------------------- #


def lire_poids(txt):
    poids = {}
    for part in txt.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise SystemExit("poids mal formé : « %s » (attendu famille=nombre)" % part)
        nom, val = part.split("=", 1)
        nom = nom.strip()
        if nom not in GABARITS:
            raise SystemExit(
                "famille inconnue : « %s » (connues : %s)" % (nom, ", ".join(GABARITS))
            )
        poids[nom] = int(val)
    if not poids:
        raise SystemExit("aucun poids")
    return poids


def main(argv=None):
    ap = argparse.ArgumentParser(description="Générateur de séries d'automatismes")
    ap.add_argument("--out", help="le dossier des séries où écrire serie-NN.md")
    ap.add_argument("--serie", type=int, help="le numéro de la série")
    ap.add_argument("--date", help="AAAA-MM-JJ")
    ap.add_argument("--count", type=int, default=70, help="nombre de questions (défaut 70)")
    ap.add_argument("--duree", type=int, default=25, help="durée en minutes (défaut 25)")
    ap.add_argument("--seed", type=int, help="graine ; à défaut, le numéro de la série")
    ap.add_argument("--weights", help="famille=poids,famille=poids")
    ap.add_argument("--check", help="vérifier une série et sortir")
    ap.add_argument("--list-templates", action="store_true", help="lister les gabarits")
    a = ap.parse_args(argv)

    if a.list_templates:
        for fam, gs in GABARITS.items():
            print("%-30s %d gabarits" % (fam, len(gs)))
            for tid, _ in gs:
                print("    " + tid)
        return 0

    if a.check:
        err, resume = verifier(a.check)
        if err:
            for ligne, msg in err:
                print("%s:%d: %s" % (a.check, ligne, msg))
            print("%d écart(s)" % len(err))
            return 1
        print(
            "OK %s · série %s · %d questions · %s min · %s"
            % (a.check, resume["numero"], resume["questions"], resume["duree"],
               ", ".join(resume["familles"]))
        )
        return 0

    for nom in ("out", "serie", "date"):
        if getattr(a, nom) is None:
            raise SystemExit("--%s est obligatoire pour générer" % nom)
    if not RE_DATE.match(a.date):
        raise SystemExit("--date attendue au format AAAA-MM-JJ")
    poids = lire_poids(a.weights) if a.weights else {f: 1 for f in GABARITS}
    seed = a.seed if a.seed is not None else a.serie

    questions = fabriquer(a.count, poids, seed)
    texte = rendre(a.serie, a.date, a.duree, questions)
    cible = Path(a.out) / ("serie-%02d.md" % a.serie)
    cible.parent.mkdir(parents=True, exist_ok=True)
    with open(cible, "w", encoding="utf-8", newline="\n") as f:
        f.write(texte)

    err, resume = verifier(cible)
    if err:
        for ligne, msg in err:
            print("%s:%d: %s" % (cible, ligne, msg))
        print("%d écart(s) : le fichier a été écrit mais il est invalide" % len(err))
        return 1
    compte = {}
    for q in questions:
        compte[q["famille"]] = compte.get(q["famille"], 0) + 1
    lettres = {}
    for q in questions:
        lettres[q["reponse"]] = lettres.get(q["reponse"], 0) + 1
    print("écrit %s" % cible)
    print("  %d questions · graine %d" % (len(questions), seed))
    print("  " + " · ".join("%s %d" % (f, n) for f, n in compte.items()))
    print("  lettres " + " ".join("%s=%d" % (l, lettres.get(l, 0)) for l in LETTRES))
    print("  gabarits utilisés : %d" % len({q["gabarit"] for q in questions}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
