'use strict';

import queue from 'queue';

import {
	getAnnotationsCount,
	getSortIndex,
	extractPageLabelPoints,
	extractPageLabel
} from './lib/extract';

import { renderAreaImage } from './lib/render';
import { annotationColors } from './lib/colors';
import { equalPositions } from './lib/utilities';
import { debounce } from './lib/debounce';

// TODO: Reorganize annotation set/unset/delete/update functions in index.*.js, viewer.js and annotations-store.js
// TODO: Debounce image annotation resizing to reduce useless intermediate images

class AnnotationsStore {
	constructor(options) {
		this.readOnly = options.readOnly;
		this.annotations = options.annotations;
		this.onSetAnnotation = options.onSetAnnotation;
		this.onDeleteAnnotations = options.onDeleteAnnotations;
		this.onUpdateAnnotations = options.onUpdateAnnotations;

		this.renderQueue = queue({
			concurrency: 1,
			autostart: true
		});

		this.debounces = [];

		document.addEventListener('pagesinit', async (e) => {

		});

		window.PDFViewerApplication.eventBus.on('pagerendered', (e) => {
			setTimeout(() => {
				this.renderMissingImages();
			}, 2000);
		});

		this.sortAnnotations(this.annotations);
	}

	async renderMissingImages() {
		for (let annotation of this.annotations) {
			if (annotation.type === 'image' && !annotation.image) {
				annotation.image = await this.getAnnotationImage(annotation.id);
				this.set(annotation);
				this.save(annotation);
			}
		}
	}

	save(annotation) {
		const DEBOUNCE_ANNOTATION = 1000;
		const DEBOUNCE_ANNOTATION_MAX = 10000;
		let fn = this.debounces[annotation.id];
		if (fn) {
			fn(annotation);
		}
		else {
			fn = debounce((annotation) => {
				delete this.debounces[annotation.id];
				this.onSetAnnotation(annotation);
			}, DEBOUNCE_ANNOTATION, { maxWait: DEBOUNCE_ANNOTATION_MAX });
			fn(annotation);
			this.debounces[annotation.id] = fn;
		}
	}

	generateObjectKey() {
		let len = 8;
		let allowedKeyChars = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';

		var randomstring = '';
		for (var i = 0; i < len; i++) {
			var rnum = Math.floor(Math.random() * allowedKeyChars.length);
			randomstring += allowedKeyChars.substring(rnum, rnum + 1);
		}
		return randomstring;
	}

	set(annotation) {
		let oldIndex = this.annotations.findIndex(x => x.id === annotation.id);
		if (oldIndex >= 0) {
			annotation = { ...annotation };
			this.annotations.splice(oldIndex, 1, annotation);
		}
		else {
			this.annotations.push(annotation);
		}
		this.sortAnnotations(this.annotations);
		this.onUpdateAnnotations(this.annotations);
	}

	async getPageLabelPoints() {
		if (!this.pageLabelPoints) {
			this.pageLabelPoints = await extractPageLabelPoints();
		}

		return this.pageLabelPoints;
	}

	getAnnotations() {
		return this.annotations;
	}

	getAnnotationByID(id) {
		return this.annotations.find(annotation => annotation.id === id);
	}

	sortAnnotations(annotations) {
		annotations.sort((a, b) => (a.sortIndex > b.sortIndex) - (a.sortIndex < b.sortIndex)
		);
	}

	// Called when changes come from the client side
	unsetAnnotations(ids) {
		for (let id of ids) {
			let index = this.annotations.findIndex(x => x.id === id);
			if (index >= 0) {
				this.annotations.splice(index, 1);
			}
		}
		this.onUpdateAnnotations(this.annotations);
	}

	async addAnnotation(annotation) {
		if (this.readOnly) {
			return;
		}

		// Those properties can be set on creation
		annotation.color = annotation.color || annotationColors[0];
		annotation.text = annotation.text || '';
		annotation.comment = annotation.comment || '';
		annotation.tags = annotation.tags || [];
		// annotation.sortIndex

		// All other are set automatically
		annotation.id = this.generateObjectKey();
		annotation.dateCreated = (new Date()).toISOString();
		annotation.dateModified = annotation.dateCreated;
		annotation.authorName = '';
		annotation.pageLabel = '-';

		annotation.position.rects = annotation.position.rects.map(
			rect => rect.map(value => parseFloat(value.toFixed(3)))
		);

		// Immediately render the annotation to prevent
		// delay from the further async calls
		this.set(annotation);

		let points = await this.getPageLabelPoints();
		if (points) {
			let pageLabel = await extractPageLabel(annotation.position.pageIndex, points);
			if (pageLabel) {
				annotation.pageLabel = pageLabel;
			}
		}

		if (annotation.pageLabel === '-') {
			let pageLabels = window.PDFViewerApplication.pdfViewer._pageLabels;
			if (pageLabels && pageLabels[annotation.position.pageIndex]) {
				annotation.pageLabel = pageLabels[annotation.position.pageIndex];
			}
		}

		if (annotation.pageLabel === '-') {
			annotation.pageLabel = (annotation.position.pageIndex + 1).toString();
		}

		if (annotation.type === 'note' || annotation.type === 'image') {
			annotation.sortIndex = await getSortIndex(annotation.position);
		}

		if (annotation.type === 'image') {
			annotation.image = await this.getAnnotationImage(annotation.id);
		}

		this.set(annotation);
		this.save(annotation);

		return annotation;
	}

	// Called when changes come from the client side
	async setAnnotation(annotation) {
		annotation.readOnly = this.readOnly;
		this.set(annotation);
		if (annotation.type === 'image' && !annotation.image) {
			annotation.image = await this.getAnnotationImage(annotation.id);
			this.set(annotation);
			this.save(annotation);
		}
	}

	async updateAnnotation(annotation) {
		if (this.readOnly) {
			return;
		}

		let existingAnnotation = this.getAnnotationByID(annotation.id);

		annotation = {
			...existingAnnotation,
			...annotation,
			position: { ...existingAnnotation.position, ...annotation.position }
		};
		annotation.dateModified = (new Date()).toISOString();
		annotation.position.rects = annotation.position.rects.map(
			rect => rect.map(value => parseFloat(value.toFixed(3)))
		);

		// Immediately render the annotation to prevent
		// delay from the further async calls
		this.set(annotation);

		if (
			['note', 'image'].includes(annotation.type)
			&& !equalPositions(existingAnnotation, annotation)
		) {
			annotation.sortIndex = await getSortIndex(annotation.position);
		}

		if (
			annotation.type === 'image'
			&& !equalPositions(existingAnnotation, annotation)
		) {
			annotation.image = await this.getAnnotationImage(annotation.id);
		}

		this.set(annotation);
		this.save(annotation);
	}

	deleteAnnotations(ids) {
		if (this.readOnly) {
			return;
		}

		this.annotations = this.annotations.filter(
			annotation => !ids.includes(annotation.id)
		);

		this.onDeleteAnnotations(ids);
		this.onUpdateAnnotations(this.annotations);
	}

	async getAnnotationImage(annotationID) {
		return new Promise((resolve) => {
			this.renderQueue.push(async () => {
				let image = '';
				try {
					let annotation = this.getAnnotationByID(annotationID);
					if (annotation) {
						image = await renderAreaImage(annotation.position);
					}
				}
				catch (e) {
				}
				resolve(image);
			});
		});
	}

	resetPageLabels(pageIndex, pageLabel) {
		if (parseInt(pageLabel).toString() !== pageLabel) {
			return;
		}

		let startPageNumber = parseInt(pageLabel) - pageIndex;

		for (let annotation of this.annotations) {
			let pageNumber = startPageNumber + annotation.position.pageIndex;
			annotation.pageLabel = pageNumber.toString();
			this.set(annotation);
			this.save(annotation);
		}
	}
}

export default AnnotationsStore;
