"""Claude-powered market analysis and RFP generation."""

import os
import anthropic

MODEL = "claude-sonnet-4-6"

COMPANY_PROFILE = """
PROFIL D'ENTREPRISE — AGILOS

Agilos est une société de conseil IT belge spécialisée dans les solutions Data & Analytics.

EXPERTISES PRINCIPALES :
1. Business Intelligence : Qlik Sense, QlikView, Qlik Cloud, Qlik NPrinting, Power BI, SAP BusinessObjects, Vizlib
2. ETL & Intégration de données : Talend, Qlik Data Integration, TimeXtender, SSIS, dbt, Qlik Replicate
3. Architecture de données : Data Warehouse, Data Modeling, Data Lake, Databricks, Data Mesh, Snowflake
4. Cloud : Microsoft Azure, AWS, Qlik Cloud, Snowflake
5. Développement web & applicatif : HTML, CSS, JavaScript, Bootstrap, NodeJS, APIs REST, Web Mashups, Qlik Analytics Platform (QAP)
6. Intelligence Artificielle & ML : projets IA/ML, LLM, NLP, automatisation intelligente, RAG
7. ERP : SAP consulting, implémentation, reporting SAP
8. Bases de données : SQL Server, Oracle, PostgreSQL, Amazon Redshift, SAP HANA
9. Gestion de projet : AGILE/SCRUM, PMBOK, PMI, Design Thinking

CONSULTANTS DISPONIBLES :
- Jean-François Dierckx (JFD) : BI Architect & Project Manager, 25+ ans. Expert Qlik, SAP, Data Warehouse, gestion de projet, presales
- Loïc Lestienne (LLE) : Technical Consultant. Admin Qlik, Azure, Office 365, Infrastructure IT, migration Qlik Cloud
- Michael Laenen (MLA) : BI Architect. Expert Qlik Sense/QAP (développement avancé, web mashup, analytics platform), JS/NodeJS
- Piepezi Priso Mbape (PPR) : BI Developer, 7+ ans. Qlik, Power BI, ETL, migration de données, coaching
- Sofiene Khayati (SKH) : Senior BI & ETL Consultant, Team Lead technique. Expert Qlik, Talend, TimeXtender, Power BI, ETL
- Thomas Duvivier (TDU) : Data Platform Engineer, 15+ ans. TimeXtender, Power BI, Databricks, dbt, Data Mesh
- Vivien Rossignon (VRO) : Data Architect & Project Lead, 12+ ans. Qlik, Power BI, Azure, Snowflake, Data Warehouse, ETL

SECTEURS D'EXPÉRIENCE : Finance, Santé/Hôpital, Administration Publique, Manufacturing, Retail, RH, Automotive, Institutions Européennes

RÉFÉRENCES NOTABLES :
- ECDC (Centre Européen de Prévention des Maladies) — COVID-19 Vaccine Tracker en Qlik Sense
- Banque de Luxembourg — Migration QlikView → Qlik Sense (300 utilisateurs)
- CTIE / Ministère de la Santé Luxembourg — Portail public de statistiques de mortalité
- Umicore — Data Platform HR (Databricks, dbt, Data Mesh)
- Doosan Bobcat EMEA — Machine IQ dashboards (5 milliards de lignes, IoT)
- Grand Hôpital de Charleroi — Audit et optimisation Qlik Sense

MARCHÉS PERTINENTS POUR AGILOS (nous POUVONS répondre) :
✓ Développement IT, logiciels, applications web/mobiles
✓ Business Intelligence, Data Analytics, reporting, dashboarding
✓ ERP — implémentation, consulting, reporting (SAP, etc.)
✓ Intégration de données, ETL, data engineering, migration de données
✓ Architecture de données, data warehouse, data lake
✓ Consulting IT, conseil technique, assistance à maîtrise d'ouvrage IT
✓ Intelligence Artificielle, Machine Learning, LLM, automatisation
✓ Infrastructure IT, cloud computing, administration systèmes
✓ Transformation digitale, digitalisation de processus
✓ Formation informatique, coaching IT
✓ Data Consultants / profils IT en régie ou forfait

MARCHÉS NON PERTINENTS (nous NE POUVONS PAS répondre) :
✗ Travaux de construction, génie civil, bâtiment
✗ Services de nettoyage / entretien de locaux
✗ Services de transport, logistique physique
✗ Restauration, alimentation, catering
✗ Sécurité physique (gardiennage, surveillance)
✗ Équipements médicaux, pharmaceutiques, matériel médical
✗ Services juridiques (sauf si IT-juridique)
✗ Impression, fournitures de bureau (sauf IT)
✗ Ressources humaines non-IT (recrutement généraliste, formation non-IT)
"""

RELEVANCE_SYSTEM = """Tu es un expert en appels d'offres IT pour la société Agilos.
Ta mission : analyser un marché public et déterminer s'il correspond aux expertises d'Agilos.
Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte autour."""

RELEVANCE_PROMPT = """Voici un marché public à analyser :

TITRE : {title}
CATÉGORIE : {category}
AUTORITÉ CONTRACTANTE : {contracting_authority}
DATE LIMITE : {deadline}
DESCRIPTION : {description}
CONTENU COMPLET :
{full_content}

---
{company_profile}
---

Analyse ce marché et réponds en JSON avec exactement ces champs :
{{
  "is_relevant": true/false,
  "relevance_score": 0-100,
  "relevance_reason": "Explication concise en 2-3 phrases de pourquoi c'est pertinent ou non",
  "key_requirements": ["liste", "des", "compétences", "requises"],
  "matching_consultants": ["codes consultants pertinents ex: JFD, SKH"],
  "market_type": "type de marché en quelques mots",
  "estimated_effort": "estimation effort si pertinent, sinon null"
}}"""

RFP_SYSTEM = """Tu es un expert en rédaction de réponses à appels d'offres IT pour la société Agilos.
Rédige des propositions professionnelles, convaincantes et adaptées au marché cible.
Utilise le format Markdown. Rédige en français sauf si le marché est en anglais."""

RFP_PROMPT = """Génère une réponse complète à ce marché public pour la société Agilos.

MARCHÉ :
Titre : {title}
Autorité contractante : {contracting_authority}
Date limite : {deadline}
Catégorie : {category}
Description : {description}
Contenu complet :
{full_content}

Analyse de pertinence :
{relevance_reason}
Compétences clés requises : {key_requirements}
Consultants suggérés : {matching_consultants}

---
{company_profile}
---

Structure la réponse comme suit (en Markdown) :

# RÉPONSE À L'APPEL D'OFFRES
## {title}
**Soumis par :** Agilos | **Date :** {today}

---

## 1. PRÉSENTATION D'AGILOS
[Présentation de la société adaptée au contexte du marché]

## 2. COMPRÉHENSION DU BESOIN
[Analyse détaillée du besoin exprimé dans l'appel d'offres]

## 3. SOLUTION PROPOSÉE
[Solution technique proposée, outils et technologies]

## 4. ÉQUIPE PROPOSÉE
[Profils des consultants les plus adaptés avec leurs expériences pertinentes]

## 5. MÉTHODOLOGIE
[Approche projet, phases, livrables]

## 6. RÉFÉRENCES PERTINENTES
[Projets similaires réalisés par Agilos]

## 7. PLANNING INDICATIF
[Timeline avec phases principales]

## 8. PROPOSITION COMMERCIALE
[Structure tarifaire à compléter — taux journaliers ou prix forfaitaire à définir]

---
*Document généré automatiquement — à personnaliser avant envoi*
"""


def _get_client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY non configurée. Ajoutez-la dans les variables d'environnement.")
    return anthropic.Anthropic(api_key=api_key)


def analyze_market(market: dict) -> dict:
    """
    Analyze a market for relevance to Agilos.
    Returns a dict with is_relevant, relevance_score, relevance_reason, etc.
    """
    client = _get_client()

    prompt = RELEVANCE_PROMPT.format(
        title=market.get("title", ""),
        category=market.get("category", ""),
        contracting_authority=market.get("contracting_authority", ""),
        deadline=market.get("deadline", ""),
        description=market.get("description", "") or "",
        full_content=(market.get("full_content", "") or "")[:4000],
        company_profile=COMPANY_PROFILE,
    )

    import json as _json
    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=RELEVANCE_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        # Strip markdown code fences if present
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        result = _json.loads(raw)
        return result
    except _json.JSONDecodeError as exc:
        return {
            "is_relevant": False,
            "relevance_score": 0,
            "relevance_reason": f"Erreur d'analyse : {exc}",
            "key_requirements": [],
            "matching_consultants": [],
        }


def generate_rfp(market: dict) -> str:
    """
    Generate a full RFP response for a relevant market.
    Returns Markdown string.
    """
    from datetime import date

    client = _get_client()

    key_requirements = market.get("key_requirements") or []
    if isinstance(key_requirements, list):
        key_requirements = ", ".join(key_requirements)

    matching = market.get("matching_consultants") or []
    if isinstance(matching, list):
        matching = ", ".join(matching)

    prompt = RFP_PROMPT.format(
        title=market.get("title", ""),
        contracting_authority=market.get("contracting_authority", ""),
        deadline=market.get("deadline", ""),
        category=market.get("category", ""),
        description=market.get("description", "") or "",
        full_content=(market.get("full_content", "") or "")[:4000],
        relevance_reason=market.get("relevance_reason", ""),
        key_requirements=key_requirements,
        matching_consultants=matching,
        company_profile=COMPANY_PROFILE,
        today=date.today().strftime("%d/%m/%Y"),
    )

    resp = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=RFP_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.content[0].text.strip()
