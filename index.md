\[[Google Scholar](https://scholar.google.pt/citations?hl=en&user=zJ4uM00AAAAJ&view_op=list_works&sortby=pubdate)\] 
\[[GitHub](https://github.com/ramon-astudillo)\]
\[[LinkedIn](https://www.linkedin.com/in/ramonastudillo/)\]
\[[Twitter](https://twitter.com/RamonAstudill12), [BlueSky](https://bsky.app/profile/ramon-astudillo.bsky.social)\]\[[Talks](pages/talks.md)\]

I am currently **Principal Research Scientist**, **sub-theme lead for Generative Model Alignment** and **manager** at [IBM Research AI](https://research.ibm.com/artificial-intelligence) in the [T. J. Watson research center in Yorktown Heights](https://www.research.ibm.com/labs/watson/visitor.shtml) (pictured above). The sub-theme comprises two teams, one researching **Synthetic Data Generation with Large Language Models** (LLMs) and the other **Reinforcement Learning with LLMs**. Current focus in **LLM inference scaling** (both buildtime and runtime). We also contribute to **Granite post-training**. See Google Scholar link above and highlights below for recent work. Before working at IBM, I was senior Research Scientist at [Unbabel](http://www.unbabel.com/) (YC 2014) working on human and Machine Translation quality estimation. Before that I was associate researcher at [INESC-ID](https://www.l2f.inesc-id.pt/w/Welcome_to_the_Spoken_Language_Systems_Lab) in Lisboa working on robust speech and language processing. I completed my PhD at [TU Berlin](https://www.emsp.tu-berlin.de/menue/startseite/) in the areas of Speech Enhancement and Automatic Speech Recognition. I ended up spending very large chunks of my life in Spain, Germany and Portugal and now in the Unites States. It is hard to find things that do not interest me, but artificial and crowd intelligence seem particularly motivating in this moment in history. 

### 2025

- GMA **releases** [granite-3.3-8b-lora-math-prm](https://huggingface.co/ibm-granite/granite-3.3-8b-lora-math-prm) a Process Reward Model adaptor as part of its runtime strategy (upcoming). Some results [here](https://arxiv.org/abs/2505.17242), but its too early to talk about this

- [The Future of Open Human Feedback](https://www.nature.com/articles/s42256-025-01038-2.epdf?sharing_token=rP431s8_kuEGtGCF0U4yl9RgN0jAjWel9jnR3ZoTv0NCCZCbfK5rXWkzEvWdcLIdfs0c0os8lY0bUeuKcHYLZHk1yQSwi-vYocKPGMokI9Ml5PGXVXYB2zS6Hf_vZvMZ2LlRy-v0-Hf2WgTWdPt3ryUKLe59R4wbJU-CJUnXSTw%3D) led by Shachar Don-Yehiha and Leshem Choshen got **published in Nature Machine Intelligence**. Great collaboration with many partners including HuggingFace, Cohere, Cornell, CMU, Oxford, Princeton, MIT and others.

- IBM Releases [Granite-3.3](https://huggingface.co/ibm-granite/granite-3.3-8b-instruct) with **great gains in mathematical reasoning**. GMA does inference scaling "cold-start" and part of the Reinforcement Learning work.

### 2024 Principal Research Scientist, Sub-Theme Lead and Manager

- **Became sub-theme lead and manager**. GMA is now divided into two research challenges: Data Synthesis and Reinforcement Learning. Focus is now on inference-scaling, both at post-training and runtime.

- **Talked** at Cornell Tech about the BRAIn estimator from the perspective of Optimal Policy Distillation \[[slides](https://www.dropbox.com/scl/fi/rgw3b1u459106yj5hxzv8/brain_cornelltech_2024.pdf?rlkey=7yc55jl9v6txmb9txph0kp2m4&st=zydgtav3&dl=0)\]

- IBM **Releases** [Granite-3.0](https://www.rivista.ai/wp-content/uploads/2024/10/paper-1.pdf) and GMA does the Reinforcement Learning (using BRAIn) and part of the synthetic data.

- Gaurav Pandey's [BRAIn](https://proceedings.mlr.press/v235/pandey24a.html) introduces a **generalization of DPO** arising from Distributional Policy Gradient with great properties, accepted at ICML 2024

- We **internally released** `v0.3.0` of _The Simulator_.

### 2023

- Lots of progress, interesting research and tech transfer, sadly mostly behind closed doors. We **internally released** `v0.1.0` of _The Simulator_.

- **Started** the Generative Model Alignment (GMA) research challenge co-lead with Asim Munawar. The topic is given by its ambiguous constituency parse (Generative) (Model Alignment) i.e. (Structured) Synthetic Data Generation meets (Generative Model) (Alignment) i.e. Reinforcement Learning

- Our neural-parser got transferred to [WatsonNLP](https://www.ibm.com/products/natural-language-processing). We also __released as OSS__ the last version [https://github.com/IBM/transition-amr-parser/tree/v0.5.4](https://github.com/IBM/transition-amr-parser/tree/v0.5.4), including some stuff that will never be published (turns out sub-graph isomorphism for AMR-constrained decoding is tractable! we include an aligner here)

### 2022 Principal Research Scientist and Team Lead

- **Closed 4 years** of parsing and neuro-symbolic approaches for LLMs. We achieved the team's objectives of leading semantic parsing (AMR) by achieving and maintaining SoTA, creating and open sourcing the leading AMR parser and doing a ton of research. Particularly proud of the work introducing structured-heads into neural parsers and LLMs (Stack-Transformer, APT, StructBART) and our collaborations with the bigger Neuro-Symbolic theme, MIT and UMass.

- **Became** Principal Research Scientist after 3y at IBM and I feel very proud :)

- Andrew Drozdov's work on [joint neural alignment and parsing](https://aclanthology.org/2022.naacl-main.80/) shows how one can propagate aligner uncertainty to neural parser training, at NAACL 2022. Joint research work with UMass and MIT

- We __release as OSS__ version `v0.5.2` of our parser [https://github.com/IBM/transition-amr-parser/tree/v0.5.2](https://github.com/IBM/transition-amr-parser/tree/v0.5.2). This includes neural aligner above.

### 2021

- Jiawei Zhou's [Structured-BART](https://aclanthology.org/2021.emnlp-main.507/) shows how BART can be fine-tuned to interiorize a parser's state, yielding a __new SoTA for AMR parsing__ and built-in alignments, at EMNLP 2021

- Jiawei Zhou's [Action Pointer Transformer (APT)](https://aclanthology.org/2021.naacl-main.443/) decouples node and token representations yielding a lighter, more performant, 100% coverage oracle for AMR parsing, at NAACL 2021

- Peng Quian's [revisits](https://aclanthology.org/2021.acl-long.289/) Generative Parsing and Structural Scaffolds, showing they can increase linguistic generalization in Transformers, work with Prof. Roger Levi, under the __MIT-IBM program__, at ACL 2021

- We __release as OSS__ APT (`v0.4.2`) and Structured-BART (`v0.5.1`) within `transition-amr-parser` [https://github.com/IBM/transition-amr-parser](https://github.com/IBM/transition-amr-parser)

### 2020

- Manuel Mager's [GPT-too](https://aclanthology.org/2020.acl-main.167/) paper reaches a __new SoTA in AMR-to-txt__, presented at ACL 2020 

- We achieve __new SoTA in AMR-parsing__ by [leveraging self-learning](https://aclanthology.org/2020.findings-emnlp.288/) (silver parses, AMR-to-text, oracle mining) and cycle consistency.

- We __release as open source__ (Apache 2) our core tool, the `transition-amr-parser`, implementing the stack-Transformer (`v0.3.4`) [https://github.com/IBM/transition-amr-parser](https://github.com/IBM/transition-amr-parser).

- Thrilled to start a __collaboration with MIT's Professor Roger Levi__ from the Department of Brain and Cognitive Sciences on is Neuro-Symbolic methods (MIT-IBM program).

### 2019 Research Staff Member and Team Lead

- Murali Karthik's paper __shortlisted for best student paper__ at Interspeech 2019!. JSALT2018 follow-up applying cycle-consistency to fine-tune end-to-end ASR with unpaired speech and text \[[preprint](https://arxiv.org/abs/1905.01152)\]

- __Joined IBM research AI in NY__ as Research Staff Member at the Multilingual Natural Language Processing (MNLP) group in the [T. J. Watson research center in Yorktown Heights](https://www.research.ibm.com/labs/watson/visitor.shtml).

- After 6 years, Emmanuel and I are __leaving our positions__ as president and secretary of the RoSP-SIG. Shinji Watanabe and Marc Delcroix are taking over.

- After 9 great years as Research Associate at the [Spoken Language Systems lab at INESC-ID](https://www.l2f.inesc-id.pt/w/Welcome_to_the_Spoken_Language_Systems_Lab) in Lisbon, I am (reluctantly!) __leaving INESC-ID__ to move to my next step. I leave great friends from which I have learned a lot, an amazing infrastructure and fun memories.

### 2018

- __Talked__ at some company in Berlin about the current state of Quality Estimation for Machine Translation (some details about our WMT 2018 work) \[[slides](https://www.dropbox.com/s/js44ga3ulwbdsie/nqe.pdf?dl=0)\]

- __Visiting scholar__ at Johns Hopkins University for the [5th Jelinek Summer Workshop (JSALT2018)](https://www.clsp.jhu.edu/workshops/18-workshop/multilingual-end-end-asr-incomplete-data/). Investigated cicle-consistency losses to learn from unpaired text and speech at Takaaki Hori and Shinji Watanabe's team.

- After 2.5 years I am __leaving Unbabel__. What a ride. From 28 employees to 130, funding rounds A and B and a concentrated dose of the start-up life. A privilege to have been in a start-up that hires such amazing talent. 

- __Talked__ at university of Hildeberg about the impact of deep learning in Spoken Language Translation (mostly about my separate knowledge of ASR and MT) \[[slides](https://www.dropbox.com/s/dira36wh9dmnill/nslt.pdf?dl=0)\]

- __Co-created__ this years word and document-level Quality Estimation (QE) WMT tasks \[[paper](https://www.aclweb.org/anthology/W18-6451)\]. Corpus builder for word-level QE with optional adequacy task (thought for NMT) \[[code](https://github.com/ramon-astudillo/word-level-qe-corpus-builder)\]

- __Co-organized__ the Automatic Post-Editing and Quality Estimation workshop at AMTA 2018 \[[slides](https://www.aclweb.org/anthology/W18-2100)\]

### 2016 Senior Research Scientist and Team Lead

- INESC-ID/L2F got the __winning system__ for Compare 2016 Native Language Identification task \[[paper](https://pdfs.semanticscholar.org/06ed/d212e9ab4225e1cde5ecd5c395792195178f.pdf)\]

- Unbabel got the __winning system__ for WMT 2016 word-level Quality Estimation task \[[paper](https://www.aclweb.org/anthology/W16-2387)\]

### 2015

- I am __joining Unbabel__!, a Y-combinator start-up focused on man-in-the-loop machine translation as senior researcher. Andre Martins and I will start Unbabel-X, its research division.

- __Co-organized__ the special session in Robust Speech Processing using Observation Uncertainty at Interspeech 2015 [website](https://www.l2f.inesc-id.pt/wiki/index.php/Robust_Speech_Processing_using_Observation_Uncertainty_and_Uncertainty_Propagation)

- Was __visiting scholar__ at the Language Technologies institute in Carnegie Melon University with the always inspiring Bhiksha Raj. Gave a talk about observation uncertainty in neural networks \[[slides](https://www.dropbox.com/s/27bo6cln3nd1tso/cmu_mlpou.pdf?dl=0)\]

- Silvio Moreira got the __winning system__ for SemEval 2015 task E \[[paper](https://www.aclweb.org/anthology/S15-2102)\]. Also got __best late-breaking system__ for task A with a transfer learning approach \[[paper](https://www.aclweb.org/anthology/P15-1104),[code](https://github.com/ramon-astudillo/NLSE)\]

### 2012

- Emmanuel Vincent and I __founded__ the ISCA Robust Speech Processing Special Interest group (RoSP-SIG) \[[website](https://wiki.inria.fr/rosp/Main_Page)\]

- __Held a tutorial__ on Uncertainty Handling for Robust Speech Recognition with Li Deng and Emmanuel Vincent at Interspeech 2012 \[[slides](https://homepages.loria.fr/evincent/talks/tutorialIS12.pdf)\] (follow-up from my thesis)

### 2010 Post-doctoral Researcher

- __best area paper award__ in Robust Speech Recognition (shortlist SPECOM best paper award) attaining MMSE estimates with Uncertainty Propagation for ASR \[[paper](https://pdfs.semanticscholar.org/91c3/bd9e42a6b7e6669ff1f1656b2f109c10f21f.pdf),[code](https://github.com/ramon-astudillo/stft_up_tools)\]

- __Joined INESC-ID's__ [Spoken Language Systems lab](https://www.l2f.inesc-id.pt/w/Welcome_to_the_Spoken_Language_Systems_Lab) with a FCT post-doctoral grant. Looking forward to apply my work on uncertainty modeling to neural networks and natural language processing

#### Phd

Obtained the Dr-Ing (PhD) title with distinction in 2010 in the fields of speech processing and robust automatic speech recognition with the thesis

**Integration of Short-Time Fourier Domain Speech Enhancement and Observation Uncertainty Techniques for Robust Automatic Speech Recognition**
\[[pdf](https://d-nb.info/1005939284/34)\] \[[code](https://github.com/ramon-astudillo/stft_up_tools)\]

My doctor-fathers were Reinhold Orglmeister and Rainer Martin, but I mostly have a doctor-mother, Dorothea Kolossa, who developed the initial idea and helped me kickstart my thesis.

In short, context for my thesis is the following

- Speech enhancement (noise reduction, dereverberation, etc) is done in the STFT domain because of its multiple advantages (source independence, spatio-temporal filtering) 

- ASR happens in feature domains like log-Mel or MFCC, that are non-linear transformations of STFT. Here speech can be represented in a more robust and compact form. 

- It would be ideal to keep your speech enhancement models in STFT domain while doing estimates in e.g. log-Mel domain.

- If we also derived a measure of enhancement uncertainty, there are well established methods to integrate this with ASR models and improve performance.

This was a relatively active topic in robust ASR at the time, with multiple competing approaches (feature/model based). My thesis contributions were basically

- Notice that the Ephraim-Malah filters can be seen as propagating the uncertainty of the posterior distribution associated to a Wiener Filter in STFT domain, through the amplitude and log-amplitude non-linearities \[[IEEE TASLP article](http://ieeexplore.ieee.org/abstract/document/6423820/)\].

- Exploiting this fact to transform a complex-Gaussian distributed model of the STFT into MFCC (log-Mel) and RASTA-PLP, deriving first and second order moments \[[Book Chapter](https://pdfs.semanticscholar.org/d32d/72e4dcc59bd014fb9f6428824df035fecaf4.pdf)\].

- Exploiting this fact to derive extensions of super-Gausian prior MMSE estimators based on mixture models \[[IEEE SPL article](http://ieeexplore.ieee.org/abstract/document/5504821/)\].

- Showing that this can improve the robustness of ASR systems without retraining, including for performant methods such as the ETSI advanced front-end \[[IEEE STSP article](http://ieeexplore.ieee.org/abstract/document/5504821/)\].

Aside from my PhD, in my time in Berlin I also got to tutor the Neural Networks Seminar of EMSP, supervised Phillip Mandelartz's Thesis and helped other students in the department with their projects and theses.

After defending my thesis I still spent some months at EMSP finishing papers. While finishing, a causality led me to discover Isabel Trancoso's department at INESC-ID in Lisbon. After reading João Graças and Diamantino Caseiros papers, I decided to apply for a post-doctoral grant to transition from speech to natural language processing. Luckily, I was awarded with a 3+3 year FCT Post-Doctoral grant to join INESC-ID/L2F. 

### 2006
I worked as an intern at Peiker Acustic for six months with the aid of a Leonardo grant and in collaboration with the TU-Berlin. The output was a spectral codebook-based speech reconstruction algorithm. Aside from realising how hard is to write a tech report in German, I also got to know better the Minimum Mean Spectral Amplitude and Log Spectral Amplitude Estimators (also known and Ephraim-Malah filters). 

on this same year I was awarded with a __La Caixa and the German Academic Exchange Service (DAAD) scholarship__ for research towards the Ph.D. degree at the EMSP department of the Technische Universität Berlin. I started working with Dorothea Kolossa on the topic of uncertainty propagation.

### 2005 Industrial Engineer, Electronics and Automatics 
I got the Industrial Engineering degree with specialization in electronics and automatics at the Escuela Politecnica Superior de Ingenieria de Gijon (Spain). At the time, this was a 6 year multidisciplinary degree plus thesis. I got to learn a lot of math/phisics and all things engineering from industrial heat and cold to macro-economy, got also to play with all levels of programming languages from VHDL and x86 CISC to Visual C++ and MFCs (no Python sadly). On my free time, I started learning fuzzy logic and programmed my first neural network.

I did my last year at Technische Universität Berlin with the aid of an Erasmus grant (2004). My final thesis was also at TU-Berlin, at the Electronics and Medical Signal Processing (EMSP) department (2005). My thesis was directed by Dorothea Kolossa and the topic was prunning in tied-mixture Hidden Markov Models for Automatic Speech Recognition.
